"""Split a photograph into depth planes for 2.5D parallax.

The effect this serves is a camera moving *through* a still rather than across
it: near things must traverse the frame faster than far things, and that one cue
is the whole difference between a place and a slideshow.

Why planes rather than a per-pixel depth warp — see docs/PARALLAX.md §3. The
short version is that planes let preview (drawImage) and render (ffmpeg
zoompan + overlay) be the *same operation*, so the export cannot disagree with
what was on screen, and the whole effect stays on render tier 1.

This is a bake: slow, once per photo, cached by content hash. Nothing here runs
at render time.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import threading
from typing import Any

from ..rpc import Context, Server, Unavailable

# Bump when the output format or the algorithm changes, so stale bakes are not
# silently reused. It is part of the cache key.
BAKE_VERSION = 4

REPO = "onnx-community/depth-anything-v2-small"
"""Depth Anything V2 Small, Apache-2.0 (Base and Large are CC-BY-NC-4.0).

Only coarse layer boundaries are needed here, not metric depth, so the small
checkpoint is not a compromise — see docs/PARALLAX.md §3.
"""

VARIANTS = {
    "quantized": "onnx/model_quantized.onnx",  # ~27MB
    "fp32": "onnx/model.onnx",  # ~99MB
}
DEFAULT_VARIANT = "quantized"

INPUT_SIZE = 518
"""DPT patches are 14px, so both input dimensions must be multiples of 14."""

PATCH = 14

# ImageNet statistics, from the model's own preprocessor_config.json.
IMAGE_MEAN = (0.485, 0.456, 0.406)
IMAGE_STD = (0.229, 0.224, 0.225)

MATTE_REPO = "onnx-community/BiRefNet_lite"
"""BiRefNet, MIT — the subject cutout.

Salient-object segmentation, not a person detector: on a portrait the salient
object IS the person, but on a scene with no dominant subject it returns almost
nothing, which the caller has to handle rather than assume away.

The hard part of matting is temporal stability, and that is a *video* problem
(docs/STACK.md §3). On a single photograph it does not exist, which is why a
permissive, high-quality matte is available here and not for footage.
"""
MATTE_VARIANTS = {"fp16": "onnx/model_fp16.onnx", "fp32": "onnx/model.onnx"}
DEFAULT_MATTE_VARIANT = "fp16"
MATTE_SIZE = 1024
"""BiRefNet takes a fixed square; the aspect is restored when the mask is
resized back, and the feather hides the resampling."""

MIN_SUBJECT = 0.01
MAX_SUBJECT = 0.92
"""A matte covering almost nothing, or almost everything, has not found a
subject — it has found the whole photograph or a speck. Either way the depth
clustering is the better answer."""

DEFAULT_LAYERS = 3
MAX_WORKING_SIZE = 2048
"""Cap the long side. Beyond this the bake gets slow for no visible gain — the
render already caps zoompan input at 2560x1440."""

FILL_FRACTION = 0.06
"""How far a layer is extended behind the ones in front of it, as a fraction of
the long side.

Only a narrow band behind each edge is ever revealed, so filling further wastes
time and invents more than it needs to. It must however cover the widest gap the
renderer can open between two planes — `MAX_PARALLAX_AMOUNT` in
shared/render/motion.ts is derived from this number, so the two stay in step."""

FLAT_THRESHOLD = 0.15
"""Minimum spread between the nearest and farthest plane, in normalised depth.

Below this the photograph has no depth structure to separate — a flat-lay, a
wall, a distant crowd. Reported rather than forced, so the caller can fall back
to an ordinary Ken Burns move instead of shipping a melted one."""

_session_lock = threading.Lock()
_sessions: dict[str, Any] = {}


def _models_dir() -> str:
    override = os.environ.get("FORGE_MODELS_DIR")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".cache", "forge", "models")


def _cache_dir() -> str:
    override = os.environ.get("FORGE_CACHE_DIR")
    base = override or os.path.join(os.path.expanduser("~"), ".cache", "forge")
    return os.path.join(base, "parallax")


def _is_cached(
    variant: str,
    repo: str = REPO,
    variants: dict[str, str] | None = None,
) -> bool:
    from huggingface_hub import try_to_load_from_cache

    table = variants if variants is not None else VARIANTS
    try:
        found = try_to_load_from_cache(repo, table[variant], cache_dir=_models_dir())
    except Exception:  # noqa: BLE001 - a cache probe must never be fatal
        return False
    return isinstance(found, str) and os.path.isfile(found)


def _session(variant: str, context: Context | None = None) -> Any:
    import onnxruntime as ort
    from huggingface_hub import hf_hub_download

    with _session_lock:
        if variant not in _sessions:
            # Say so. The first bake on a new machine fetches ~27MB, and
            # reporting it as "estimating depth" made a working download look
            # exactly like a frozen app.
            if context is not None and not _is_cached(variant):
                context.progress(
                    None, "downloading the depth model (~27MB, first run only)"
                )
            path = hf_hub_download(
                REPO, VARIANTS[variant], cache_dir=_models_dir()
            )
            options = ort.SessionOptions()
            # A bake competes with playback and the UI; leave the machine usable.
            options.intra_op_num_threads = max(1, (os.cpu_count() or 4) // 2)
            _sessions[variant] = ort.InferenceSession(
                path, options, providers=["CPUExecutionProvider"]
            )
        return _sessions[variant]


def _matte_session(variant: str, context: Context | None = None) -> Any:
    import onnxruntime as ort
    from huggingface_hub import hf_hub_download

    key = f"matte:{variant}"
    with _session_lock:
        if key not in _sessions:
            if context is not None and not _is_cached(variant, MATTE_REPO, MATTE_VARIANTS):
                context.progress(
                    None, "downloading the subject model (~115MB, first run only)"
                )
            path = hf_hub_download(MATTE_REPO, MATTE_VARIANTS[variant], cache_dir=_models_dir())
            options = ort.SessionOptions()
            options.intra_op_num_threads = max(1, (os.cpu_count() or 4) // 2)
            _sessions[key] = ort.InferenceSession(
                path, options, providers=["CPUExecutionProvider"]
            )
        return _sessions[key]


def _probe_size(path: str, ffprobe: str) -> tuple[int, int]:
    result = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "json", path],
        capture_output=True, check=False,
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise ValueError(message or f"Could not read image dimensions: {path}")
    streams = json.loads(result.stdout or b"{}").get("streams") or []
    if not streams:
        raise ValueError(f"No image stream in {path}")
    return int(streams[0]["width"]), int(streams[0]["height"])


def _decode_rgb(path: str, ffmpeg: str, width: int, height: int) -> "Any":
    """Decode to an RGB array at an exact size.

    Images go through the bundled ffmpeg for the same reason audio does: one
    decoding path in the product, and no compiled Python imaging dependency.
    """
    import numpy as np

    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error",
         "-i", path, "-vf", f"scale={width}:{height}:flags=bicubic",
         "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
        capture_output=True, check=False,
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise ValueError(message or "ffmpeg could not decode this image")
    expected = width * height * 3
    if len(result.stdout) != expected:
        raise ValueError(
            f"Decoded {len(result.stdout)} bytes, expected {expected} "
            f"for {width}x{height}"
        )
    return np.frombuffer(result.stdout, dtype=np.uint8).reshape(height, width, 3)


def _write_rgba(path: str, ffmpeg: str, rgba: "Any") -> None:
    height, width = rgba.shape[:2]
    result = subprocess.run(
        [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
         "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{width}x{height}",
         "-i", "pipe:0", "-frames:v", "1", path],
        input=rgba.tobytes(), capture_output=True, check=False,
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise ValueError(message or f"ffmpeg could not write {path}")


def _estimate_depth(
    rgb: "Any", variant: str, ffmpeg: str, path: str, context: Context | None = None
) -> "Any":
    """Disparity map at the model's own resolution. Higher means nearer.

    Verified against real photographs rather than assumed: sky reads ~0.0 and
    near ground 2.5-4.8. Getting this backwards would put the background in
    front of the subject, and would do it silently.
    """
    import numpy as np

    height, width = rgb.shape[:2]
    scale = INPUT_SIZE / max(width, height)
    target_w = max(PATCH, round(width * scale / PATCH) * PATCH)
    target_h = max(PATCH, round(height * scale / PATCH) * PATCH)

    # Re-decode at the model size rather than resampling in numpy: ffmpeg's
    # bicubic is better than anything written here would be.
    small = _decode_rgb(path, ffmpeg, target_w, target_h).astype(np.float32) / 255.0
    mean = np.array(IMAGE_MEAN, dtype=np.float32)
    std = np.array(IMAGE_STD, dtype=np.float32)
    tensor = np.ascontiguousarray(
        ((small - mean) / std).transpose(2, 0, 1)[None]
    )

    session = _session(variant, context)
    if context is not None:
        context.progress(0.3, "estimating depth")
    name = session.get_inputs()[0].name
    return np.squeeze(session.run(None, {name: tensor})[0]).astype(np.float32)


def _subject_matte(
    path: str, ffmpeg: str, variant: str, context: Context | None = None
) -> "Any":
    """Soft mask of the photograph's subject, at the model's own square size."""
    import numpy as np

    small = _decode_rgb(path, ffmpeg, MATTE_SIZE, MATTE_SIZE).astype(np.float32) / 255.0
    mean = np.array(IMAGE_MEAN, dtype=np.float32)
    std = np.array(IMAGE_STD, dtype=np.float32)
    tensor = np.ascontiguousarray(((small - mean) / std).transpose(2, 0, 1)[None])

    session = _matte_session(variant, context)
    name = session.get_inputs()[0].name
    mask = np.squeeze(session.run(None, {name: tensor})[-1]).astype(np.float32)
    # Some exports emit logits rather than probabilities.
    if mask.min() < 0.0 or mask.max() > 1.0:
        mask = 1.0 / (1.0 + np.exp(-mask))
    return np.clip(mask, 0.0, 1.0)


def _resize_nearest(array: "Any", width: int, height: int) -> "Any":
    """Depth is smooth and about to be thresholded, so index resampling is fine."""
    import numpy as np

    ys = (np.arange(height) * (array.shape[0] / height)).astype(np.int32)
    xs = (np.arange(width) * (array.shape[1] / width)).astype(np.int32)
    ys = np.clip(ys, 0, array.shape[0] - 1)
    xs = np.clip(xs, 0, array.shape[1] - 1)
    return array[ys][:, xs]


def _mask_box(mask: "Any", trim: float = 0.01) -> "dict[str, float] | None":
    """The subject's bounding box, normalised 0..1.

    Trimmed rather than exact. A matte often leaves a faint halo or a wisp of
    hair a long way from the body, and a bounding box drawn around the outermost
    lit pixel would be dragged out to it — which shows up as a close-up framed
    too wide for no visible reason. Rows and columns holding under `trim` of the
    busiest one are treated as fringe.
    """
    import numpy as np

    rows = mask.sum(axis=1).astype(np.float64)
    cols = mask.sum(axis=0).astype(np.float64)
    if rows.max() <= 0 or cols.max() <= 0:
        return None

    ys = np.nonzero(rows >= rows.max() * trim)[0]
    xs = np.nonzero(cols >= cols.max() * trim)[0]
    if ys.size == 0 or xs.size == 0:
        return None

    height, width = mask.shape[:2]
    return {
        "x": round(float(xs[0]) / width, 4),
        "y": round(float(ys[0]) / height, 4),
        "width": round(float(xs[-1] - xs[0] + 1) / width, 4),
        "height": round(float(ys[-1] - ys[0] + 1) / height, 4),
    }


def _cluster_depth(depth: "Any", layers: int) -> tuple["Any", "Any"]:
    """Split depth into planes at its own natural breaks.

    Fixed quantiles would always produce the requested number of planes, even on
    a photograph that has one — inventing a foreground where none exists. 1-D
    k-means finds where the image actually separates, and how far apart the
    centres land is then a usable measure of whether it separated at all.
    """
    import numpy as np
    from scipy.cluster.vq import kmeans2

    flat = depth.reshape(-1, 1)
    # Subsample: the centres are identical and it is far quicker.
    step = max(1, flat.shape[0] // 50_000)
    sample = flat[::step]

    seed = np.random.default_rng(0)
    centres, _ = kmeans2(sample, layers, minit="++", seed=seed, missing="warn")
    centres = np.sort(centres.ravel())

    # Assign every pixel to its nearest centre.
    boundaries = (centres[:-1] + centres[1:]) / 2
    assignment = np.digitize(depth, boundaries)
    return assignment.astype(np.int32), centres


def _clean_mask(mask: "Any", min_pixels: int) -> "Any":
    """Drop speckle and close pinholes.

    Raw per-pixel assignment scatters isolated pixels across the image; each one
    becomes a single-pixel plane that moves at the wrong rate and reads as noise.
    """
    from scipy import ndimage

    closed = ndimage.binary_closing(mask, structure=ndimage.generate_binary_structure(2, 2), iterations=2)
    labelled, count = ndimage.label(closed)
    if count == 0:
        return closed
    sizes = ndimage.sum_labels(closed, labelled, index=range(1, count + 1))
    keep = {i + 1 for i, size in enumerate(sizes) if size >= min_pixels}
    if not keep:
        return closed
    return __import__("numpy").isin(labelled, list(keep))


def _fill_from_nearest(rgb: "Any", known: "Any", within: "Any") -> "Any":
    """Paint unknown pixels with their nearest known colour.

    This is the hole behind each plane — the part of the scene the camera never
    saw, because something was standing in front of it. At a 3-4% camera move
    the revealed band is tens of pixels wide, so a nearest-neighbour fill
    followed by a blur is indistinguishable from a learned inpainter and costs
    nothing. The layer format does not change if one is swapped in later.
    """
    import numpy as np
    from scipy import ndimage

    holes = within & ~known
    if not holes.any():
        return rgb

    # EDT on the complement gives, for every pixel, the coordinates of the
    # closest pixel that *is* known.
    _, indices = ndimage.distance_transform_edt(~known, return_indices=True)
    filled = rgb.copy()
    ys, xs = indices[0][holes], indices[1][holes]
    filled[holes] = rgb[ys, xs]

    # Nearest-neighbour fill produces radial streaks. A blur confined to the
    # filled region turns them into plausible out-of-focus background.
    blurred = np.stack(
        [ndimage.gaussian_filter(filled[..., c].astype(np.float32), 6) for c in range(3)],
        axis=-1,
    )
    filled[holes] = blurred[holes].astype(np.uint8)
    return filled


def _content_key(path: str, layers: int, variant: str) -> str:
    digest = hashlib.sha1()
    digest.update(f"v{BAKE_VERSION}:{layers}:{variant}:".encode())
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()[:16]


def register(server: Server) -> None:
    try:
        import numpy  # noqa: F401
        import onnxruntime  # noqa: F401
        import scipy  # noqa: F401
        from huggingface_hub import hf_hub_download  # noqa: F401
    except ImportError as exc:
        raise Unavailable(f"depth dependencies are not installed: {exc}") from exc

    def layers_of(params: dict[str, Any], context: Context) -> dict[str, Any]:
        import numpy as np
        from scipy import ndimage

        path = params.get("path")
        if not isinstance(path, str) or not os.path.isfile(path):
            raise ValueError(f"No such image: {path!r}")

        ffmpeg = params.get("ffmpeg")
        ffprobe = params.get("ffprobe")
        if not isinstance(ffmpeg, str) or not isinstance(ffprobe, str):
            raise ValueError("Depth baking needs the paths to ffmpeg and ffprobe")

        count = params.get("layers")
        count = int(count) if isinstance(count, (int, float)) else DEFAULT_LAYERS
        count = max(2, min(4, count))

        variant = params.get("model")
        variant = variant if variant in VARIANTS else DEFAULT_VARIANT

        # Cutting the subject out properly is what makes an anchored shake hold
        # a person still rather than a depth band that happens to contain them.
        subject = params.get("subject")
        subject = True if subject is None else bool(subject)

        key = _content_key(path, count, variant + (":subject" if subject else ""))
        out_dir = os.path.join(_cache_dir(), key)
        manifest_path = os.path.join(out_dir, "manifest.json")

        if os.path.isfile(manifest_path):
            try:
                with open(manifest_path, encoding="utf-8") as handle:
                    cached = json.load(handle)
                if all(os.path.isfile(layer["file"]) for layer in cached["layers"]):
                    return {**cached, "cached": True}
            except (OSError, KeyError, ValueError):
                pass  # Rebuild rather than trust a half-written bake.

        os.makedirs(out_dir, exist_ok=True)

        context.progress(0.05, "reading the photo")
        source_w, source_h = _probe_size(path, ffprobe)
        scale = min(1.0, MAX_WORKING_SIZE / max(source_w, source_h))
        # Even dimensions keep every downstream encoder happy.
        width = max(2, int(source_w * scale) // 2 * 2)
        height = max(2, int(source_h * scale) // 2 * 2)
        rgb = _decode_rgb(path, ffmpeg, width, height)

        context.raise_if_cancelled()
        context.progress(0.2, "loading the depth model")
        disparity = _estimate_depth(rgb, variant, ffmpeg, path, context)
        depth = _resize_nearest(disparity, width, height)

        span = float(depth.max() - depth.min())
        if span <= 1e-6:
            return {
                "width": width, "height": height, "separated": False,
                "spread": 0.0, "layers": [], "cached": False,
                "reason": "this photo has no depth variation at all",
            }
        normalised = (depth - depth.min()) / span

        context.raise_if_cancelled()
        context.progress(0.45, "finding the planes")
        assignment, centres = _cluster_depth(normalised, count)

        # How far apart the planes actually sit. A flat-lay or a wall clusters
        # into bands a few percent apart, which is not depth.
        spread = float(centres[-1] - centres[0])
        separated = spread >= FLAT_THRESHOLD

        radius = max(8, int(FILL_FRACTION * max(width, height)))
        min_pixels = max(64, int(0.0004 * width * height))
        structure = ndimage.generate_binary_structure(2, 2)

        context.progress(0.6, "cutting the planes")
        masks = []
        for index in range(count):
            mask = _clean_mask(assignment == index, min_pixels)
            masks.append(mask)

        """Replace the front plane with a real subject cutout when we have one."""
        subject_used = False
        subject_box = None
        if subject:
            try:
                context.progress(0.55, "finding the subject")
                soft = _subject_matte(path, ffmpeg, DEFAULT_MATTE_VARIANT, context)
                cut = _resize_nearest(soft, width, height) > 0.5
                share = float(cut.mean())
                if MIN_SUBJECT <= share <= MAX_SUBJECT:
                    cut = _clean_mask(cut, min_pixels)
                    # The subject owns its pixels outright; every other plane
                    # gives them up, so nothing is drawn twice.
                    for index in range(count - 1):
                        masks[index] = masks[index] & ~cut
                    masks[count - 1] = cut
                    subject_used = True
                    # Where the person is, not just that there is one. Without
                    # it every crop of the photograph is a guess: a close-up
                    # framed on the middle of the frame lands on their waist.
                    subject_box = _mask_box(cut)
                else:
                    context.progress(0.58, "no clear subject — using depth alone")
            except Exception as exc:  # noqa: BLE001 - a matte is an upgrade, not a requirement
                context.progress(0.58, f"subject model unavailable ({exc})")

        # Anything no plane claimed after cleaning falls to the back, so the
        # composite is always gap-free.
        claimed = np.zeros((height, width), dtype=bool)
        for mask in masks[1:]:
            claimed |= mask
        masks[0] = ~claimed

        written = []
        for index in range(count):
            context.raise_if_cancelled()
            context.progress(0.6 + 0.3 * (index + 1) / count, f"filling plane {index + 1}")

            own = masks[index]
            nearer = np.zeros((height, width), dtype=bool)
            for other in masks[index + 1:]:
                nearer |= other

            if index == 0:
                # The backdrop is opaque and full-frame: everything in front of
                # it will move, and there must be something behind.
                support = np.ones((height, width), dtype=bool)
            else:
                # Extend only into the band the nearer planes will uncover.
                grown = ndimage.binary_dilation(own, structure, iterations=radius // 2)
                support = own | (grown & nearer)

            rgba = np.zeros((height, width, 4), dtype=np.uint8)
            rgba[..., :3] = _fill_from_nearest(rgb, own, support)

            if index == 0:
                rgba[..., 3] = 255
            else:
                # Feather the cutout: a hard edge on a moving plane reads as a
                # sticker, and the depth boundary is approximate anyway.
                alpha = ndimage.gaussian_filter(support.astype(np.float32), 1.5)
                rgba[..., 3] = np.clip(alpha * 255, 0, 255).astype(np.uint8)

            file_path = os.path.join(out_dir, f"plane{index}.png")
            _write_rgba(file_path, ffmpeg, rgba)
            # A matted subject is definitively the front: pinning it to 1.0
            # makes an anchored shake hold it perfectly still, rather than
            # merely slowly, and drives it hardest under parallax.
            plane_depth = (
                1.0 if (subject_used and index == count - 1) else float(centres[index])
            )
            written.append({
                "file": file_path,
                "index": index,
                # 0 = farthest, 1 = nearest. This is what sets each plane's
                # parallax rate at render time.
                "depth": round(plane_depth, 4),
                "coverage": round(float(own.mean()), 4),
            })

        manifest = {
            "width": width,
            "height": height,
            # A real subject cutout is a separation even on a flat backdrop —
            # a portrait against a plain wall has almost no depth spread and is
            # exactly the case anchored shake is for.
            "separated": separated or subject_used,
            "spread": round(spread, 4),
            "layers": written,
            "model": variant,
            "subject": subject_used,
            # Normalised 0..1, so it reads the same against the working size,
            # the photograph's own pixels, or a thumbnail.
            **({"subjectBox": subject_box} if subject_box else {}),
            "version": BAKE_VERSION,
            **({} if separated else {
                "reason": "this photo is too flat to separate — the planes would all move together"
            }),
        }
        with open(manifest_path, "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, indent=1)

        context.progress(1.0, "done")
        return {**manifest, "cached": False}

    server.register("depth.layers", layers_of)

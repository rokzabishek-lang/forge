"""Objective measurements of a photograph — the Director's small eyes.

The VLM says what is IN a photo; this says how GOOD it is, with arithmetic a
model cannot do on a downscaled image (docs/PLAN.md §4.2): how sharp, how
exposed, and whether it is a near-copy of another. Where the two disagree on
something measured here, the measurement wins — a small model on a 640-px
thumbnail cannot see blur.

These are the measurements OpenCV would make, done with the numpy and scipy
the depth bake already brought (scipy comes with librosa), so the capability
costs no new dependency. Decoding goes through the bundled ffmpeg, as every
other image and sound in the product does.

Nothing here judges. It returns numbers; `src/shared/director/gate.ts` decides
what they mean, relative to the SET — a soft-focus wedding set is a look, not
ten rejects.
"""

from __future__ import annotations

import os
from typing import Any

from ..rpc import Context, Server, Unavailable
from .depth import _decode_rgb, _probe_size

WORK_EDGE = 512
"""Long side EVERY photo is measured at — smaller ones scaled up too. Sharpness
is compared across a set, so it has to be measured at one size: measured at
its own, a 480-px copy of a picture read sharper than the 640-px original
(908 against 805). Scaling a small photo up is also the honest answer — it is
soft when it fills a phone screen."""

HASH_W, HASH_H = 9, 8
"""dHash: 9×8 block means, each compared with its right-hand neighbour — 64 bits."""

FLAT_STD = 2.0
"""Below this spread of luma (0–255) the picture is flat — one colour, or a
blank frame — and its hash is all zeros whatever it shows. Two flat pictures
would then always "match", so a flat picture gets no hash rather than a
meaningless one."""

LUMA = (0.2126, 0.7152, 0.0722)


def _block_means(grey: "Any", rows: int, cols: int) -> "Any":
    import numpy as np

    out = np.empty((rows, cols), dtype=np.float64)
    for i, band in enumerate(np.array_split(grey, rows, axis=0)):
        for j, block in enumerate(np.array_split(band, cols, axis=1)):
            out[i, j] = block.mean()
    return out


def backdrop_share(clipped: "Any") -> float:
    """The share of the picture that is clipped white AND in a region reaching the frame's edge.

    A product on a white studio backdrop clips most of its pixels to white by
    design — measured 2026-09-26 on four real product-listing photos: 71 % and
    61 % for the box and the bottle on white, 1 % for the same bottle on teal —
    and a rule that reads ``brightClip`` alone calls both blown, so neither may
    ever be the hero. What is blown is a highlight INSIDE the picture, on the
    face or the product. So the clipped regions that touch the border are
    counted apart here, and the gate judges what is left. A white sky counts as
    backdrop too, which is right: a portrait against it is not a reject.
    """
    import numpy as np
    from scipy import ndimage

    if not clipped.any():
        return 0.0
    labels, count = ndimage.label(clipped)
    if count == 0:
        return 0.0
    edge = np.unique(np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]]))
    edge = edge[edge != 0]
    if edge.size == 0:
        return 0.0
    return float(np.isin(labels, edge).mean())


def measure_rgb(rgb: "Any") -> dict[str, Any]:
    """The numbers for one decoded picture (H×W×3 uint8)."""
    import numpy as np
    from scipy import ndimage

    grey = rgb.astype(np.float64) @ np.array(LUMA)
    sharpness = float(ndimage.laplace(grey).var())
    std = float(grey.std())
    clipped = grey > 247

    dhash: str | None = None
    if std >= FLAT_STD:
        blocks = _block_means(grey, HASH_H, HASH_W)
        bits = (blocks[:, 1:] > blocks[:, :-1]).flatten()
        value = 0
        for bit in bits:
            value = (value << 1) | int(bit)
        dhash = f"{value:016x}"

    return {
        "sharpness": sharpness,
        "luma": float(grey.mean() / 255.0),
        "lumaStd": std / 255.0,
        "darkClip": float((grey < 8).mean()),
        "brightClip": float(clipped.mean()),
        "backdropClip": backdrop_share(clipped),
        "dhash": dhash,
    }


def _measure(path: str, ffmpeg: str, ffprobe: str) -> dict[str, Any]:
    width, height = _probe_size(path, ffprobe)
    scale = WORK_EDGE / max(width, height)
    w = max(2, int(width * scale) // 2 * 2)
    h = max(2, int(height * scale) // 2 * 2)
    rgb = _decode_rgb(path, ffmpeg, w, h)
    return {**measure_rgb(rgb), "width": width, "height": height}


def register(server: Server) -> None:
    try:
        import numpy  # noqa: F401
        import scipy  # noqa: F401
    except ImportError as exc:
        raise Unavailable(f"vision dependencies are not installed: {exc}") from exc

    def measure(params: dict[str, Any], context: Context) -> dict[str, Any]:
        paths = params.get("paths")
        if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
            raise ValueError("vision.measure needs a list of paths")
        ffmpeg = params.get("ffmpeg")
        ffprobe = params.get("ffprobe")
        if not isinstance(ffmpeg, str) or not isinstance(ffprobe, str):
            raise ValueError("vision.measure needs the paths to ffmpeg and ffprobe")

        results: list[dict[str, Any]] = []
        total = max(1, len(paths))
        for index, path in enumerate(paths):
            context.raise_if_cancelled()
            # One unreadable photo costs that photo, not the set.
            try:
                if not os.path.isfile(path):
                    raise ValueError(f"No such image: {path!r}")
                results.append({"path": path, **_measure(path, ffmpeg, ffprobe)})
            except Exception as exc:  # noqa: BLE001 - reported per photo
                results.append({"path": path, "error": str(exc)})
            context.progress((index + 1) / total, f"measured {index + 1} of {len(paths)}")
        return {"measures": results}

    server.register("vision.measure", measure)

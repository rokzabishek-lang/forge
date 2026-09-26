/** Seconds, where the loudest 10 ms window sits, and how loud it is (dBFS, RMS). */
export function measureSound(file: string): Promise<{ seconds: number; peakSeconds: number; peakDb: number }>

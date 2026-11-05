export type BundleSummary = {
  id: string;
  path: string;
  photoCount: number;
  sizeBytes: number;
};

export function planPhotoBundles(
  existingBundles: BundleSummary[],
  fileSizes: number[],
  limitBytes: number,
): { bundles: BundleSummary[]; assignments: string[] };

export function planPhotoBundles(existingBundles, fileSizes, limitBytes) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new Error('Photo bundle limit is invalid.');
  const bundles = existingBundles.map((bundle) => ({ ...bundle }));
  const assignments = [];
  let nextNumber = bundles.reduce((highest, bundle) => {
    const number = Number(/^bundle-(\d{3,})$/.exec(bundle.id)?.[1]);
    return Math.max(highest, Number.isFinite(number) ? number : 0);
  }, 0);

  for (const size of fileSizes) {
    if (!Number.isSafeInteger(size) || size < 1) throw new Error('Photo size is invalid.');
    if (size > limitBytes) throw new Error('A processed image exceeds the photo bundle limit.');
    let current = bundles.at(-1);
    if (!current || current.sizeBytes + size > limitBytes) {
      nextNumber += 1;
      current = {
        id: `bundle-${String(nextNumber).padStart(3, '0')}`,
        path: `photos/bundle-${String(nextNumber).padStart(3, '0')}/`,
        photoCount: 0,
        sizeBytes: 0,
      };
      bundles.push(current);
    }
    current.photoCount += 1;
    current.sizeBytes += size;
    assignments.push(current.id);
  }
  return { bundles, assignments };
}

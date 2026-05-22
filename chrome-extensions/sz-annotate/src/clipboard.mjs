export async function dataUrlToBlob(dataUrl) {
  const response = await fetch(dataUrl);
  return await response.blob();
}

export async function buildClipboardItemData(markdown, pngDataUrl) {
  return {
    'text/plain': new Blob([markdown], { type: 'text/plain' }),
    'image/png': await dataUrlToBlob(pngDataUrl),
  };
}

export async function writePromptAndImageToClipboard(markdown, pngDataUrl, clipboard = navigator.clipboard, ClipboardItemCtor = globalThis.ClipboardItem) {
  if (!ClipboardItemCtor) throw new Error('ClipboardItem is not available in this browser context.');
  const itemData = await buildClipboardItemData(markdown, pngDataUrl);
  await clipboard.write([new ClipboardItemCtor(itemData)]);
}

export async function writeImageToClipboard(pngDataUrl, clipboard = navigator.clipboard, ClipboardItemCtor = globalThis.ClipboardItem) {
  if (!ClipboardItemCtor) throw new Error('ClipboardItem is not available in this browser context.');
  const imageBlob = await dataUrlToBlob(pngDataUrl);
  await clipboard.write([new ClipboardItemCtor({ 'image/png': imageBlob })]);
}

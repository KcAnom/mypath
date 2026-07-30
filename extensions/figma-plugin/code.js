figma.showUI(__html__, { width: 420, height: 520, themeColors: true });
const rgba = (paint) => paint?.type === 'SOLID' ? { type: 'solid', color: { r: paint.color.r, g: paint.color.g, b: paint.color.b, a: paint.opacity ?? 1 }, opacity: paint.opacity ?? 1, visible: paint.visible !== false } : null;
function exportNode(node) {
  const type = node.type === 'TEXT' ? 'text' : node.type === 'ELLIPSE' ? 'ellipse' : node.type === 'RECTANGLE' ? 'rectangle' : node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'INSTANCE' ? 'frame' : 'group';
  const output = { id: node.id, type, name: node.name, x: node.x || 0, y: node.y || 0, width: node.width || 0, height: node.height || 0, rotation: node.rotation || 0, opacity: node.opacity ?? 1, visible: node.visible !== false, clipsContent: Boolean(node.clipsContent), fills: Array.isArray(node.fills) ? node.fills.map(rgba).filter(Boolean) : [], strokes: Array.isArray(node.strokes) ? node.strokes.map(rgba).filter(Boolean) : [], strokeWidth: node.strokeWeight || 0, cornerRadius: typeof node.cornerRadius === 'number' ? node.cornerRadius : 0, effects: [], children: 'children' in node ? node.children.map(exportNode) : [] };
  if (type === 'text') { output.text = node.characters; output.typography = { family: typeof node.fontName === 'object' ? node.fontName.family : 'Inter', style: typeof node.fontName === 'object' ? node.fontName.style : 'Regular', weight: 400, size: typeof node.fontSize === 'number' ? node.fontSize : 16, lineHeight: 1.2, letterSpacing: 0, align: String(node.textAlignHorizontal || 'LEFT').toLowerCase() }; }
  if ('layoutMode' in node) output.autoLayout = { mode: String(node.layoutMode || 'NONE').toLowerCase(), gap: node.itemSpacing || 0, padding: { top: node.paddingTop || 0, right: node.paddingRight || 0, bottom: node.paddingBottom || 0, left: node.paddingLeft || 0 }, primaryAlign: String(node.primaryAxisAlignItems || 'MIN').toLowerCase().replace('min','start').replace('max','end'), counterAlign: String(node.counterAxisAlignItems || 'MIN').toLowerCase().replace('min','start').replace('max','end'), wrap: node.layoutWrap === 'WRAP' };
  return output;
}
async function importNode(node) {
  let created;
  if (node.type === 'text') { created = figma.createText(); await figma.loadFontAsync({ family: 'Inter', style: 'Regular' }); created.characters = node.text || ''; created.fontSize = node.typography?.size || 16; }
  else if (node.type === 'ellipse') created = figma.createEllipse();
  else if (node.type === 'rectangle' || node.type === 'image') created = figma.createRectangle();
  else created = figma.createFrame();
  created.name = node.name || node.type; created.resize(Math.max(1, node.width || 100), Math.max(1, node.height || 100)); created.x = node.x || 0; created.y = node.y || 0; created.opacity = node.opacity ?? 1; created.visible = node.visible !== false;
  const solid = node.fills?.find((paint) => paint.type === 'solid'); if (solid) created.fills = [{ type: 'SOLID', color: { r: solid.color.r, g: solid.color.g, b: solid.color.b }, opacity: solid.color.a ?? solid.opacity ?? 1 }];
  if ('appendChild' in created) for (const child of node.children || []) created.appendChild(await importNode(child));
  return created;
}
figma.ui.onmessage = async (message) => {
  try {
    if (message.type === 'export') { const selected = figma.currentPage.selection; const frames = (selected.length ? selected : figma.currentPage.children.filter((node) => node.type === 'FRAME')).map(exportNode).map((node) => ({ ...node, type: 'frame' })); figma.ui.postMessage({ type: 'exported', exchange: { version: 'FigmaExchangeV1', document: { name: figma.root.name }, frames, assets: [], metadata: { generator: 'mypath-figma-plugin' } } }); }
    if (message.type === 'import') { const exchange = message.exchange; if (exchange?.version !== 'FigmaExchangeV1' || !Array.isArray(exchange.frames)) throw new Error('Expected FigmaExchangeV1 JSON'); const created = []; for (const frame of exchange.frames) { const node = await importNode(frame); figma.currentPage.appendChild(node); created.push(node); } figma.currentPage.selection = created; figma.viewport.scrollAndZoomIntoView(created); figma.notify(`Imported ${created.length} frame(s)`); }
  } catch (error) { figma.ui.postMessage({ type: 'error', message: String(error?.message || error) }); }
};

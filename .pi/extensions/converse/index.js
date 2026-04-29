export default async function converseHotReloadShim(pi) {
  const tag = Date.now().toString();
  const moduleUrl = new URL(`../../../dist/pi/index.js?ts=${tag}`, import.meta.url);
  const mod = await import(moduleUrl.href);
  return mod.default(pi);
}

const ASSET_COMPOSITE_ROUTES = new Set();

export function canHandleAssetCompositeApiRoute(method, pathname) {
  return ASSET_COMPOSITE_ROUTES.has(`${method} ${pathname}`);
}

export async function handleAssetCompositeApi({ req, res, url, context, sendJson }) {
  return false;
}

# Toepoel's Planner – Release Notes v1.20

## Fixes
- Service Worker: API fetch failures (zoals afgebroken typeahead-requests naar /stations) worden nu netjes opgevangen.
  Hierdoor geen `Uncaught (in promise) TypeError: Failed to fetch` meer in `sw.js` en geen FetchEvent warnings.
- Versienummer opgehoogd naar 1.20 (cache-busting + assets).

## Upgrade tip
Na deploy één keer in de browser:
- DevTools → Application → Service Workers → Unregister
- Clear storage → Clear site data
- Hard refresh (Ctrl+Shift+R)

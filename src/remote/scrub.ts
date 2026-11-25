/** Error text the remote server may show a caller: no stack, no filesystem path, bounded. */
const STACK_LINE = /^\s+at\s.*$/gm;
const FILE_PATH = /(?:file:\/\/)?(?:[A-Za-z]:)?(?:\/(?:Users|home|opt|var|root|tmp|private|srv|app|usr)\/[^\s'"`)]*|[^\s'"`(]*node_modules[^\s'"`)]*|\/[^\s'"`:()]+\.(?:ts|js|mjs|cjs|json)(?::\d+){0,2})/g;

export function scrubError(msg: string): string {
  const clean = String(msg)
    .replace(STACK_LINE, '')
    .replace(FILE_PATH, '[path]')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return (clean || 'The request failed.').slice(0, 500);
}

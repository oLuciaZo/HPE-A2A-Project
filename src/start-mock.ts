// Cross-platform way to run the demo: `npm run mock` (no `MOCK=1 cmd` shell syntax, which Windows lacks).
process.env.MOCK = '1';
await import('./start.js');

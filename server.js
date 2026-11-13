// Start the app on this PC:  node server.js   (see src/local-server.mjs)
import('./src/local-server.mjs').catch(e => { console.error(e); process.exit(1); });

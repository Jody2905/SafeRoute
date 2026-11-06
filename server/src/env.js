// Loads environment variables. `neon deploy` / `neon env pull` write to .env.local
// (or .env if it exists); values in .env.local win.
const path = require('path');
require('dotenv').config({
  path: [path.join(__dirname, '..', '.env.local'), path.join(__dirname, '..', '.env')],
  quiet: true,
});

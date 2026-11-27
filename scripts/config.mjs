// Shows green-compute's settings as they apply now (defaults merged with ~/.green-compute/config.json).
// Usage: node config.mjs            prints the settings as JSON
//        node config.mjs path       prints where the file is (edit it with any editor)
import { readConfig, CONFIG_FILE } from '../control-room/lib.mjs';

if (process.argv[2] === 'path') console.log(CONFIG_FILE);
else console.log(JSON.stringify({ file: CONFIG_FILE, ...readConfig() }, null, 2));

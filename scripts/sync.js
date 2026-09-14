import { syncTodo } from '../src/sync/index.js';

const args = process.argv.slice(2);
const entidades = args.includes('--entidad')
  ? args[args.indexOf('--entidad') + 1]?.split(',')
  : null;
const annos = args.includes('--anno')
  ? args[args.indexOf('--anno') + 1]?.split(',').map(Number)
  : null;

await syncTodo({ entidades, annos });
process.exit(0);

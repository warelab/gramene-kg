// pm2 apps for gramene-kg. Start with a clean environment so no shell variables leak into the app:
//   env -i HOME=$HOME USER=$USER PATH=$PATH pm2 start ecosystem.config.cjs --only gramene-kg-api
// Never `pm2 restart all` on this host.
const NODE = '/home/olson/.nvm/versions/node/v24.14.1/bin/node';
module.exports = {
  apps: [
    {
      name: 'gramene-kg-api',
      cwd: __dirname,
      script: 'apps/api/server.mjs',
      interpreter: NODE,
      node_args: '--max-old-space-size=2048',
      env: {
        KG_PORT: '12000', KG_HOST: '0.0.0.0', KG_SITE: 'sorghumbase',
        MONGO_URL: 'mongodb://127.0.0.1:27017', SOLR_URL: 'http://127.0.0.1:8983/solr',
        TMPDIR: '/scratch/olson/gramene-kg/tmp', NODE_ENV: 'production',
      },
      max_memory_restart: '2G',
      out_file: '/scratch/olson/gramene-kg/logs/api.out.log',
      error_file: '/scratch/olson/gramene-kg/logs/api.err.log',
      merge_logs: true,
    },
  ],
};

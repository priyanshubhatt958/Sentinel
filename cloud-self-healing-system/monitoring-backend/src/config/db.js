const { Client } = require('pg');

const dbConfig = {
  host: process.env.PGHOST || 'database',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'cloud_user',
  password: process.env.PGPASSWORD || 'cloud_password',
  database: process.env.PGDATABASE || 'cloud_self_healing'
};

const client = new Client(dbConfig);

module.exports = { client, dbConfig };

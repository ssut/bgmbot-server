require('dotenv/config');

const path = require('path');
const parse = require('pg-connection-string');
const url = parse(process.env.POSTGRES_URL);

module.exports = {
  "type": "postgres",
  "host": url.host,
  "port": Number(url.port) || 5432,
  "username": url.username || url.user,
  "password": url.password,
  "database": url.database,
  "schema": url.schema,
  "synchronize": true,
  "logging": true,
  "entities": [
    path.join(__dirname, './{app,dist}/entities/*.{ts,js}'),
  ]
};

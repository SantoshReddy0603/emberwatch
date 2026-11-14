import mongoose from 'mongoose';
import { config } from './config.js';
import { log } from './obs/log.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri = config.mongoUri) {
  await mongoose.connect(uri, { maxPoolSize: 20, serverSelectionTimeoutMS: 8000 });
  log.info({ db: mongoose.connection.name }, 'mongo connected');
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}

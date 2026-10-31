import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { fileURLToPath } from 'node:url';
import 'reflect-metadata';
import { AppModule } from './app.module.js';

const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.useStaticAssets(fileURLToPath(new URL('../public', import.meta.url)));

const port = Number(process.env.PORT ?? 3000);
await app.listen(port);
console.log(`Open http://localhost:${port} (user: demo, password: demo)`);

import { NestFactory } from '@nestjs/core';
import 'reflect-metadata';
import { ResourceModule } from './resource.module.js';

const app = await NestFactory.create(ResourceModule);
const port = Number(process.env.PORT ?? 3001);
await app.listen(port);
console.log(`Verify-only API on http://localhost:${port}/api/orders`);

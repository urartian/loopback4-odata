import { ApplicationConfig } from '@loopback/core';
import { ExampleApp } from '..';

export async function migrate(args: string[] = []) {
    const app = new ExampleApp();

    await app.boot();
    await app.migrateSchema({
        existingSchema: 'drop', // or 'drop' | 'create'
    });

    // Optional: Seed data after migration
    // if (args.includes('--seed')) {
    //     await seedData(app);
    // }

    await app.stop();
}

// async function seedData(app: ExampleApp) {
//     const userRepo = await app.get('repositories.UserRepository');
//     await userRepo.create({ name: 'Admin', email: 'admin@example.com' });
//     console.log('Seeded default users');
// }

if (require.main === module) {
    migrate(process.argv).catch(err => {
        console.error('Cannot migrate database schema', err);
        process.exit(1);
    });
}

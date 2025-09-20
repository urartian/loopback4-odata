import { RestApplication } from '@loopback/rest';
import { ODataComponent } from './component';

async function main() {
    const app = new RestApplication({ rest: { port: 3001, host: '127.0.0.1' } });
    app.component(ODataComponent);
    await app.start();
    console.log('Dev OData on http://127.0.0.1:3001/odata/$metadata');
}
main();

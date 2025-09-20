export class CsdlGenerator {
    contentType(format: 'xml' | 'json' = 'xml'): string {
        return format === 'xml' ? 'application/xml' : 'application/json';
    }

    generate(): string {
        return `<?xml version="1.0" encoding="UTF-8"?>
<edmx:Edmx Version="4.0"
 xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="App" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityContainer Name="Default"/>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
    }
}

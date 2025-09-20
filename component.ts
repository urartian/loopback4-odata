import { Component, Binding } from '@loopback/core';
import { ODataConfig } from './types';
import { ODATA_BINDINGS } from './keys';
import { CsdlGenerator } from './metadata/csdl-generator';
import { ODataMetadataController } from './controllers/metadata.controller';

export class ODataComponent implements Component {
    bindings = [
        Binding.bind(ODATA_BINDINGS.CONFIG).to({ basePath: '/odata' } as ODataConfig),
        Binding.bind(ODATA_BINDINGS.CSDL_GEN).toClass(CsdlGenerator),
    ];

    // Register controllers provided by this extension
    controllers = [ODataMetadataController];
}

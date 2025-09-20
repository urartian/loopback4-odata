import { BindingKey } from '@loopback/core';
import { ODataConfig } from './types';
import { CsdlGenerator } from './metadata/csdl-generator';

export const ODATA_BINDINGS = {
    CONFIG: BindingKey.create<ODataConfig>('odata.config'),
    CSDL_GEN: BindingKey.create<CsdlGenerator>('odata.csdl'),
};

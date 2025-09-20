export interface ODataConfig {
    basePath?: string;             // default '/odata'
    csdlFormat?: 'xml' | 'json';   // default 'xml' 
    maxTop?: number;
    enableCount?: boolean;
    strict?: boolean;
}

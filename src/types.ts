export interface ODataConfig {
    basePath?: string;             // default '/odata'
    csdlFormat?: 'xml' | 'json';   // default 'xml' 
    maxTop?: number;
    enableCount?: boolean;
    strict?: boolean;
    // Search configuration
    searchMode?: 'annotated' | 'config-only' | 'all' | 'disabled';
    searchFields?: Record<string, string[]>; // per entity set
    maxSearchFields?: number; // cap number of fields used in $search
    maxSearchTerms?: number;  // cap number of tokens parsed from $search
    // Limits & safety
    maxExpandDepth?: number;  // maximum allowed $expand nesting depth (strict enforced)
    maxSkip?: number;         // maximum allowed $skip (strict enforced)
}

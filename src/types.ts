export interface ODataConfig {
    basePath?: string;             // default '/odata'
    csdlFormat?: 'xml' | 'json';   // default 'xml' 
    namespace?: string;            // default 'Default'
    entityContainerName?: string;  // default 'DefaultContainer'
    namespaceAlias?: string;       // optional schema alias
    capabilities?: ODataCapabilityDefaults;
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

export interface ODataNavigationRestriction {
    navigable?: boolean;
}

export interface ODataPermissionScope {
    scope: string;
    description?: string;
}

export interface ODataEntityPermission {
    scheme?: string;
    scopes: Array<string | ODataPermissionScope>;
}

export interface ODataCapabilitiesConfig {
    filterFunctions?: string[];
    countable?: boolean;
    navigationRestrictions?: Record<string, ODataNavigationRestriction>;
    permissions?: ODataEntityPermission[];
    hasStream?: boolean;
}

export interface ODataCapabilityDefaults extends ODataCapabilitiesConfig {
    navigationRestrictionDefaults?: ODataNavigationRestriction;
}

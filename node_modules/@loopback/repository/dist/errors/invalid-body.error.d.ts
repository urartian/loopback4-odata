import { Entity } from '../model';
export declare class InvalidBodyError<ID, Props extends object = {}> extends Error {
    code: string;
    entityName: string;
    entityId: ID;
    statusCode: number;
    constructor(entityOrName: typeof Entity | string, entityId: ID, extraProperties?: Props);
}
export declare function isInvalidBodyError(e: any): e is InvalidBodyError<any>;

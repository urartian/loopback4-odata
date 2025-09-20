"use strict";
// Copyright IBM Corp. and LoopBack contributors 2018,2019. All Rights Reserved.
// Node module: @loopback/repository
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT
Object.defineProperty(exports, "__esModule", { value: true });
exports.isInvalidBodyError = exports.InvalidBodyError = void 0;
class InvalidBodyError extends Error {
    constructor(entityOrName, entityId, extraProperties) {
        const entityName = typeof entityOrName === 'string'
            ? entityOrName
            : entityOrName.modelName || entityOrName.name;
        super('Data is required for the patch request');
        Error.captureStackTrace(this, this.constructor);
        this.code = 'INVALID_BODY_DEFINITION';
        this.statusCode = 400;
        this.entityName = entityName;
        this.entityId = entityId;
        Object.assign(this, extraProperties);
    }
}
exports.InvalidBodyError = InvalidBodyError;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isInvalidBodyError(e) {
    return e instanceof InvalidBodyError;
}
exports.isInvalidBodyError = isInvalidBodyError;
//# sourceMappingURL=invalid-body.error.js.map
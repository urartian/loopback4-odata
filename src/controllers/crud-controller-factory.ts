import {
    get,
    post,
    patch,
    del,
    param,
    requestBody,
} from '@loopback/rest';
import { EntitySetDef } from '../registry/entityset-registry';

/**
 * Factory that creates a dedicated CRUD controller for an entity set.
 */
export function defineODataCrudController(def: EntitySetDef) {
    const { name: setName, modelCtor } = def;

    class ODataCrudController {
        // List all
        @get(`/odata/${setName}`, {
            responses: {
                '200': {
                    description: `List of ${setName}`,
                    content: { 'application/json': { schema: { type: 'array' } } },
                },
            },
        })
        async list() {
            return {
                '@odata.context': `/odata/$metadata#${setName}`,
                value: [`This would return all ${setName}`],
            };
        }

        // Find by id
        @get(`/odata/${setName}/{id}`, {
            responses: {
                '200': {
                    description: `${setName} by id`,
                    content: { 'application/json': { schema: { type: 'object' } } },
                },
            },
        })
        async findById(@param.path.string('id') id: string) {
            return {
                '@odata.context': `/odata/$metadata#${setName}/$entity`,
                value: `This would return ${setName} with id=${id}`,
            };
        }

        // Create
        @post(`/odata/${setName}`, {
            responses: {
                '200': {
                    description: `Create a ${setName} entity`,
                    content: { 'application/json': { schema: { type: 'object' } } },
                },
            },
        })
        async create(@requestBody() body: unknown) {
            return { message: `Would create ${setName}`, data: body };
        }

        // Update
        @patch(`/odata/${setName}/{id}`, {
            responses: {
                '200': {
                    description: `Update a ${setName} entity`,
                    content: { 'application/json': { schema: { type: 'object' } } },
                },
            },
        })
        async update(
            @param.path.string('id') id: string,
            @requestBody() body: unknown,
        ) {
            return { message: `Would update ${setName} id=${id}`, data: body };
        }

        // Delete
        @del(`/odata/${setName}/{id}`, {
            responses: {
                '200': {
                    description: `Delete a ${setName} entity`,
                    content: { 'application/json': { schema: { type: 'object' } } },
                },
            },
        })
        async delete(@param.path.string('id') id: string) {
            return { message: `Would delete ${setName} id=${id}` };
        }
    }

    Object.defineProperty(ODataCrudController, 'name', {
        value: `${setName}ODataController`,
    });
    def.controllerCtor = ODataCrudController;
    return ODataCrudController;
}

// The below is meant to be an alternative canonical schema stitching example
// which relies on type merging.

import { delegateToSchema } from '@graphql-tools/delegate';
import { normalizedExecutor } from '@graphql-tools/executor';
import { addMocksToSchema } from '@graphql-tools/mock';
import { makeExecutableSchema } from '@graphql-tools/schema';
import { assertSome } from '@graphql-tools/utils';
import { RenameRootFields, RenameTypes } from '@graphql-tools/wrap';
import { graphql, OperationTypeNode, parse } from 'graphql';
import { describe, expect, it, test } from 'vitest';
import { stitchSchemas } from '../src/stitchSchemas.js';

describe('merging using type merging', () => {
  test('works', async () => {
    let chirpSchema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Chirp {
          id: ID!
          text: String
          author: User
          coAuthors: [User]
          authorGroups: [[User]]
        }

        type User {
          id: ID!
          chirps: [Chirp]
        }
        type Query {
          userById(id: ID!): User
        }
      `,
    });

    chirpSchema = addMocksToSchema({ schema: chirpSchema });

    let authorSchema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type User {
          id: ID!
          email: String
        }
        type Query {
          userById(id: ID!): User
        }
      `,
    });

    authorSchema = addMocksToSchema({ schema: authorSchema });

    const stitchedSchema = stitchSchemas({
      subschemas: [
        {
          schema: chirpSchema,
          merge: {
            User: {
              fieldName: 'userById',
              args: (originalResult) => ({ id: originalResult.id }),
              selectionSet: '{ id }',
            },
          },
          batch: true,
        },
        {
          schema: authorSchema,
          merge: {
            User: {
              fieldName: 'userById',
              args: (originalResult) => ({ id: originalResult.id }),
              selectionSet: '{ id }',
            },
          },
          batch: true,
        },
      ],
    });

    const query = /* GraphQL */ `
      query {
        userById(id: 5) {
          __typename
          chirps {
            id
            textAlias: text
            author {
              email
            }
            coAuthors {
              email
            }
            authorGroups {
              email
            }
          }
        }
      }
    `;

    const result = await graphql({
      schema: stitchedSchema,
      source: query,
    });

    expect(result.errors).toBeUndefined();
    assertSome(result.data);
    const userByIdData: any = result.data['userById'];
    expect(userByIdData.__typename).toBe('User');
    expect(userByIdData.chirps[1].id).not.toBe(null);
    expect(userByIdData.chirps[1].text).not.toBe(null);
    expect(userByIdData.chirps[1].author.email).not.toBe(null);
  });

  test('handle top level failures on subschema queries', async () => {
    let userSchema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type User {
          id: ID!
          email: String
        }
        type Query {
          userById(id: ID!): User
        }
      `,
    });

    userSchema = addMocksToSchema({ schema: userSchema });

    const failureSchema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type User {
          id: ID!
          fail: Boolean
        }

        type Query {
          userById(id: ID!): User
        }
      `,
      resolvers: {
        Query: {
          userById: () => {
            throw new Error('failure message');
          },
        },
      },
    });

    const stitchedSchema = stitchSchemas({
      subschemas: [
        {
          schema: failureSchema,
          merge: {
            User: {
              fieldName: 'userById',
              selectionSet: '{ id }',
              args: (originalResult) => ({ id: originalResult.id }),
            },
          },
          batch: true,
        },
        {
          schema: userSchema,
          merge: {
            User: {
              fieldName: 'userById',
              selectionSet: '{ id }',
              args: (originalResult) => ({ id: originalResult.id }),
            },
          },
          batch: true,
        },
      ],
    });

    const query = /* GraphQL */ `
      query {
        userById(id: 5) {
          id
          email
          fail
        }
      }
    `;

    const result = await graphql({
      schema: stitchedSchema,
      source: query,
    });

    expect(result.errors).not.toBeUndefined();
    expect(result.data).toMatchObject({ userById: { fail: null } });
    expect(result.errors).toMatchObject([
      {
        message: 'failure message',
        path: ['userById', 'fail'],
      },
    ]);
  });

  test('merging types and type extensions should work together', async () => {
    const resultSchema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          resultById(id: ID!): String
        }
      `,
      resolvers: {
        Query: {
          resultById: () => 'ok',
        },
      },
    });

    const containerSchemaA = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Container {
          id: ID!
          resultId: ID!
        }

        type Query {
          containerById(id: ID!): Container
        }
      `,
      resolvers: {
        Query: {
          containerById: () => ({ id: 'Container', resultId: 'Result' }),
        },
      },
    });

    const containerSchemaB = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Container {
          id: ID!
        }

        type Query {
          containerById(id: ID!): Container
          rootContainer: Container!
        }
      `,
      resolvers: {
        Query: {
          containerById: () => ({ id: 'Container' }),
          rootContainer: () => ({ id: 'Container' }),
        },
      },
    });

    const schema = stitchSchemas({
      subschemas: [
        {
          schema: resultSchema,
          batch: true,
        },
        {
          schema: containerSchemaA,
          merge: {
            Container: {
              fieldName: 'containerById',
              args: ({ id }) => ({ id }),
              selectionSet: '{ id }',
            },
          },
          batch: true,
        },
        {
          schema: containerSchemaB,
          merge: {
            Container: {
              fieldName: 'containerById',
              args: ({ id }) => ({ id }),
              selectionSet: '{ id }',
            },
          },
          batch: true,
        },
      ],
      typeDefs: /* GraphQL */ `
        extend type Container {
          result: String!
        }
      `,
      resolvers: {
        Container: {
          result: {
            selectionSet: `{ resultId }`,
            resolve(container, _args, context, info) {
              return delegateToSchema({
                schema: resultSchema,
                operation: 'query' as OperationTypeNode,
                fieldName: 'resultById',
                args: {
                  id: container.resultId,
                },
                context,
                info,
              });
            },
          },
        },
      },
    });

    const result = await graphql({
      schema,
      source: /* GraphQL */ `
        query TestQuery {
          rootContainer {
            id
            result
          }
        }
      `,
    });

    const expectedResult = {
      data: {
        rootContainer: {
          id: 'Container',
          result: 'ok',
        },
      },
    };

    expect(result).toEqual(expectedResult);
  });
});

describe('Merged associations', () => {
  const layoutSchema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Network {
        id: ID!
        domain: String!
      }
      type Post {
        id: ID!
        sections: [String]!
      }
      type Query {
        networks(ids: [ID!]!): [Network]!
        _posts(ids: [ID!]!): [Post]!
      }
    `,
    resolvers: {
      Query: {
        networks: (_root, { ids }) =>
          ids.map((id: any) => ({ id, domain: `network${id}.com` })),
        _posts: (_root, { ids }) =>
          ids.map((id: any) => ({
            id,
            sections: ['News'],
          })),
      },
    },
  });

  const postsSchema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Network {
        id: ID!
      }
      type Post {
        id: ID!
        title: String!
        network: Network
      }
      type Query {
        posts(ids: [ID!]!): [Post]!
      }
    `,
    resolvers: {
      Query: {
        posts: (_root, { ids }) =>
          ids.map((id: any) => ({
            id,
            title: `Post ${id}`,
            network: { id: Number(id) + 2 },
          })),
      },
    },
  });

  const gatewaySchema = stitchSchemas({
    subschemas: [
      {
        schema: layoutSchema,
        merge: {
          Network: {
            selectionSet: '{ id }',
            fieldName: 'networks',
            key: ({ id }) => id,
            argsFromKeys: (ids) => ({ ids }),
          },
          Post: {
            selectionSet: '{ id }',
            fieldName: '_posts',
            key: ({ id }) => id,
            argsFromKeys: (ids) => ({ ids }),
          },
        },
      },
      {
        schema: postsSchema,
        merge: {
          Post: {
            selectionSet: '{ id }',
            fieldName: 'posts',
            key: ({ id }) => id,
            argsFromKeys: (ids) => ({ ids }),
          },
        },
      },
    ],
  });

  it('merges object with own remote type and association with associated remote type', async () => {
    const { data } = await graphql({
      schema: gatewaySchema,
      source: /* GraphQL */ `
        query {
          posts(ids: [55]) {
            title
            network {
              domain
            }
            sections
          }
        }
      `,
    });
    assertSome(data);
    expect(data['posts']).toEqual([
      {
        title: 'Post 55',
        network: { domain: 'network57.com' },
        sections: ['News'],
      },
    ]);
  });
});

describe('merging using type merging when renaming', () => {
  test('works', async () => {
    let chirpSchema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Chirp {
          id: ID!
          text: String
          author: User
          coAuthors: [User]
          authorGroups: [[User]]
        }

        type User {
          id: ID!
          chirps: [Chirp]
        }
        type Query {
          userById(id: ID!): User
        }
      `,
    });

    chirpSchema = addMocksToSchema({ schema: chirpSchema });

    let authorSchema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type User {
          id: ID!
          email: String
        }
        type Query {
          userById(id: ID!): User
        }
      `,
    });

    authorSchema = addMocksToSchema({ schema: authorSchema });

    const stitchedSchema = stitchSchemas({
      subschemas: [
        {
          schema: chirpSchema,
          transforms: [
            new RenameTypes((name) => `Gateway_${name}`),
            new RenameRootFields((_operation, name) => `Chirp_${name}`),
          ],
          merge: {
            Gateway_User: {
              fieldName: 'Chirp_userById',
              args: (originalResult) => ({ id: originalResult.id }),
              selectionSet: '{ id }',
            },
          },
          batch: true,
        },
        {
          schema: authorSchema,
          transforms: [
            new RenameTypes((name) => `Gateway_${name}`),
            new RenameRootFields((_operation, name) => `User_${name}`),
          ],
          merge: {
            Gateway_User: {
              fieldName: 'User_userById',
              args: (originalResult) => ({ id: originalResult.id }),
              selectionSet: '{ id }',
            },
          },
          batch: true,
        },
      ],
    });

    const query = /* GraphQL */ `
      query {
        User_userById(id: 5) {
          __typename
          chirps {
            id
            textAlias: text
            author {
              email
            }
            coAuthors {
              email
            }
            authorGroups {
              email
            }
          }
        }
      }
    `;

    const result = await graphql({
      schema: stitchedSchema,
      source: query,
    });

    expect(result.errors).toBeUndefined();
    assertSome(result.data);
    const userByIdData: any = result.data['User_userById'];
    expect(userByIdData.__typename).toBe('Gateway_User');
    expect(userByIdData.chirps[1].id).not.toBe(null);
    expect(userByIdData.chirps[1].text).not.toBe(null);
    expect(userByIdData.chirps[1].author.email).not.toBe(null);
  });
  it('union merge', async () => {
    const carVehicle = {
      id: '1',
      brand: 'Tesla',
      __typename: 'Car',
    };

    const vehiclesSchema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        type Query {
          getVehicle: Vehicle!
        }

        union Vehicle = Car | Bike

        type Car {
          id: ID!
          brand: String!
        }

        type Bike {
          id: ID!
          brand: String!
        }
      `,
      resolvers: {
        Query: {
          getVehicle: () => carVehicle,
        },
        Vehicle: {
          __resolveType: () => 'Car',
        },
      },
    });
    const licensePlateSchema = makeExecutableSchema({
      typeDefs: /* GraphQL */ `
        scalar Any
        type Query {
          _entities(representations: [Any]!): [Entity]!
        }
        union Entity = Car
        type Car {
          id: ID!
          licensePlate: String!
        }
      `,
      resolvers: {
        Query: {
          _entities: (_, { representations }: { representations: any[] }) =>
            representations,
        },
        Entity: {
          __resolveType: (root: any) => root.__typename,
        },
        Car: {
          licensePlate: () => 'ZH 1234',
        },
      },
    });
    const stitchedSchema = stitchSchemas({
      subschemas: [
        {
          schema: vehiclesSchema,
          merge: {
            Vehicle: {
              fieldName: 'getVehicle',
              selectionSet: '{ id }',
              key: (representation) => representation,
              argsFromKeys: (representations) => ({ representations }),
            },
          },
        },
        {
          schema: licensePlateSchema,
          merge: {
            Car: {
              fieldName: '_entities',
              selectionSet: '{ id }',
              key: (representation) => representation,
              argsFromKeys: (representations) => ({ representations }),
            },
          },
        },
      ],
    });
    const result = await normalizedExecutor({
      schema: stitchedSchema,
      document: parse(/* GraphQL */ `
        {
          getVehicle {
            ... on Car {
              id
              brand
              licensePlate ## 💥
            }
          }
        }
      `),
    });
    expect(result).toEqual({
      data: {
        getVehicle: {
          id: '1',
          brand: 'Tesla',
          licensePlate: 'ZH 1234',
        },
      },
    });
  });
});

describe('external object annotation with batchDelegateToSchema', () => {
  const networkSchema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Domain {
        id: ID!
        name: String!
      }
      type Network {
        id: ID!
        domains: [Domain!]!
      }
      type Query {
        networks(ids: [ID!]!): [Network!]!
      }
    `,
    resolvers: {
      Query: {
        networks: (_root, { ids }) =>
          ids.map((id: unknown) => ({
            id,
            domains: [{ id: Number(id) + 3, name: `network${id}.com` }],
          })),
      },
    },
  });

  const postsSchema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Network {
        id: ID!
      }
      type Post {
        id: ID!
        network: Network!
      }
      type Query {
        posts(ids: [ID!]!): [Post]!
      }
    `,
    resolvers: {
      Query: {
        posts: (_root, { ids }) =>
          ids.map((id: unknown) => ({
            id,
            network: { id: Number(id) + 2 },
          })),
      },
    },
  });

  const gatewaySchema = stitchSchemas({
    subschemas: [
      {
        schema: networkSchema,
        merge: {
          Network: {
            fieldName: 'networks',
            selectionSet: '{ id }',
            key: (originalObject) => originalObject.id,
            argsFromKeys: (ids) => ({ ids }),
          },
        },
      },
      {
        schema: postsSchema,
      },
    ],
  });

  test('if batchDelegateToSchema can delegate 2 times the same key', async () => {
    const { data } = await graphql({
      schema: gatewaySchema,
      source: /* GraphQL */ `
        query {
          posts(ids: [55, 55]) {
            network {
              id
              domains {
                id
                name
              }
            }
          }
        }
      `,
    });
    assertSome(data);
    expect(data['posts']).toEqual([
      {
        network: { id: '57', domains: [{ id: '60', name: 'network57.com' }] },
      },
      {
        network: { id: '57', domains: [{ id: '60', name: 'network57.com' }] },
      },
    ]);
  });
});

describe('type merge repeated nested delegates', () => {
  const cities = [
    {
      name: 'Chicago',
      population: 2710000,
      country: { name: 'United States' },
    },
    { name: 'Marseille', population: 861000, country: { name: 'France' } },
    { name: 'Miami', population: 454279, country: { name: 'United States' } },
    { name: 'Paris', population: 2161000, country: { name: 'France' } },
  ];
  const citySchema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Country {
        name: String!
      }

      type City {
        name: String!
        population: Float!
        country: Country!
      }

      type Query {
        citiesByName(name: [String]!): [City!]!
      }
    `,
    resolvers: {
      Query: {
        citiesByName: (_root, { name }) =>
          name.map((n: string) => cities.find((c) => c.name === n)),
      },
    },
  });

  const countries = [
    {
      name: 'United States',
      population: 328200000,
      continent: { name: 'North America' },
    },
    { name: 'France', population: 67060000, continent: { name: 'Europe' } },
  ];
  const countrySchema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Continent {
        name: String!
      }

      type Country {
        name: String!
        population: Float!
        continent: Continent!
      }

      type Query {
        countriesByName(name: [String]!): [Country!]!
      }
    `,
    resolvers: {
      Query: {
        countriesByName: (_root, { name }) =>
          name.map((n: string) => countries.find((c) => c.name === n)),
      },
    },
  });

  const continents = [
    { name: 'North America', population: 579000000 },
    { name: 'Europe', population: 746400000 },
  ];
  const continentSchema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Continent {
        name: String!
        population: Float!
      }

      type Query {
        continentsByName(name: [String]!): [Continent!]!
      }
    `,
    resolvers: {
      Query: {
        continentsByName: (_root, { name }) =>
          name.map((n: string) => continents.find((c) => c.name === n)),
      },
    },
  });

  const gatewaySchema = stitchSchemas({
    subschemas: [
      {
        schema: citySchema,
        batch: true,
      },
      {
        schema: countrySchema,
        batch: true,
        merge: {
          Country: {
            fieldName: 'countriesByName',
            selectionSet: '{ name }',
            key: ({ name }) => name,
            argsFromKeys: (name) => ({ name }),
          },
        },
      },
      {
        schema: continentSchema,
        batch: true,
        merge: {
          Continent: {
            fieldName: 'continentsByName',
            selectionSet: '{ name }',
            key: ({ name }) => name,
            argsFromKeys: (name) => ({ name }),
          },
        },
      },
    ],
  });

  test('completes merge for all children', async () => {
    const { data } = await graphql({
      schema: gatewaySchema,
      source: /* GraphQL */ `
        query {
          citiesByName(name: ["Chicago", "Miami", "Paris", "Marseille"]) {
            name
            population
            country {
              name
              population
              continent {
                name
                population
              }
            }
          }
        }
      `,
    });
    assertSome(data);
    expect(data['citiesByName']).toEqual([
      {
        name: 'Chicago',
        population: 2710000,
        country: {
          name: 'United States',
          population: 328200000,
          continent: {
            name: 'North America',
            population: 579000000,
          },
        },
      },
      {
        name: 'Miami',
        population: 454279,
        country: {
          name: 'United States',
          population: 328200000,
          continent: {
            name: 'North America',
            population: 579000000,
          },
        },
      },
      {
        name: 'Paris',
        population: 2161000,
        country: {
          name: 'France',
          population: 67060000,
          continent: {
            name: 'Europe',
            population: 746400000,
          },
        },
      },
      {
        name: 'Marseille',
        population: 861000,
        country: {
          name: 'France',
          population: 67060000,
          continent: {
            name: 'Europe',
            population: 746400000,
          },
        },
      },
    ]);
  });
});

it('shared fields but one of them is not resolvable', async () => {
  const A = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        productFromA(id: ID): Product
        # No category resolver is present
      }

      type Product {
        id: ID
        category: Category
      }

      type Category {
        details: String
      }
    `,
    resolvers: {
      Query: {
        productFromA: (_, { id }) => ({
          id,
          category: { details: `Details for Product#${id}` },
        }),
      },
    },
  });

  const B = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        productFromB(id: ID): Product
      }
      type Product {
        id: ID
        category: Category
      }
      type Category {
        id: ID
      }
    `,
    resolvers: {
      Query: {
        productFromB: (_, { id }) => ({
          id,
          category: {
            id: 3,
          },
        }),
      },
    },
  });
  const C = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        categoryFromC(id: ID): Category
      }

      type Category {
        id: ID
        name: String
      }
    `,
    resolvers: {
      Query: {
        categoryFromC: (_, { id }) => ({
          id,
          name: `Category#${id}`,
        }),
      },
    },
  });
  const D = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        productFromD(id: ID): Product
      }
      type Product {
        id: ID
        name: String
      }
    `,
    resolvers: {
      Query: {
        productFromD: (_, { id }) => ({
          id,
          name: `Product#${id}`,
        }),
      },
    },
  });

  const gatewaySchema = stitchSchemas({
    subschemas: [
      {
        schema: A,
        merge: {
          Product: {
            selectionSet: `{ id }`,
            fieldName: 'productFromA',
            args: ({ id }) => ({ id }),
          },
        },
      },
      {
        schema: B,
        merge: {
          Product: {
            selectionSet: `{ id }`,
            fieldName: 'productFromB',
            args: ({ id }) => ({ id }),
          },
        },
      },
      {
        schema: C,
        merge: {
          Category: {
            selectionSet: `{ id }`,
            fieldName: 'categoryFromC',
            args: ({ id }) => ({ id }),
          },
        },
      },
      {
        schema: D,
        merge: {
          Product: {
            selectionSet: `{ id }`,
            fieldName: 'productFromD',
            args: ({ id }) => ({ id }),
          },
        },
      },
    ],
  });

  const query = /* GraphQL */ `
    query {
      productFromD(id: "1") {
        id
        name
        category {
          id
          name
          details
        }
      }
    }
  `;
  const result = await normalizedExecutor({
    schema: gatewaySchema,
    document: parse(query),
  });
  expect(result).toEqual({
    data: {
      productFromD: {
        id: '1',
        name: 'Product#1',
        category: {
          id: '3',
          name: 'Category#3',
          details: 'Details for Product#1',
        },
      },
    },
  });
});

it('resolves fields from different subschemas using merge queries', async () => {
  // GlobalStore schema - has order with transactions but not pointsPaymentSpecificAttributes
  const GlobalStore = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      scalar SchemaStitchingKey

      type Query {
        order(id: ID!, marketplaceId: ID!): Order
      }

      type Order {
        id: ID!
        marketplaceId: ID!
        transactions(first: Int): TransactionConnection
      }

      type TransactionConnection {
        paymentTransactionList: [PaymentTransaction]
      }

      type PaymentTransaction {
        id: ID!
        amount: Float
        # pointsPaymentSpecificAttributes is not defined here
      }
    `,
    resolvers: {
      Query: {
        order: (_, { id, marketplaceId }) => ({
          id,
          marketplaceId,
          transactions: {
            paymentTransactionList: [{ id: 't1', amount: 688.0 }], // CNY amount (GlobalStore)
          },
        }),
      },
    },
  });

  // PaymentCareService schema - has special _payment_order merge query for pointsPaymentSpecificAttributes
  const PaymentCareService = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      scalar _SchemaStitchingKey

      type Query {
        # Merge query that would be ignored before the PR
        _payment_order(key: _SchemaStitchingKey): Order
      }

      type Order {
        transactions(first: Int): TransactionConnection
      }

      type TransactionConnection {
        paymentTransactionList: [PaymentTransaction]
      }

      type PaymentTransaction {
        pointsPaymentSpecificAttributes: PointsAttributes
        processorDetails: ProcessorDetails
        settlementVerificationCode: String
        statusDetails: StatusDetails
      }

      type PointsAttributes {
        pointsRate: Float
      }

      type ProcessorDetails {
        processorName: String
        processorTraceIdCode: String
      }

      type StatusDetails {
        partnerCustomerPaymentReference: String
        partnerCustomerPaymentReferenceName: String
      }
    `,
    resolvers: {
      Query: {
        _payment_order: (_, { key }) => ({
          transactions: {
            paymentTransactionList: [
              {
                pointsPaymentSpecificAttributes: {
                  pointsRate: 0.01,
                },
                processorDetails: {
                  processorName: 'USDProcessor',
                  processorTraceIdCode: 'USD123456',
                },
                settlementVerificationCode: 'USD789012',
                statusDetails: {
                  partnerCustomerPaymentReference: 'USD123',
                  partnerCustomerPaymentReferenceName: 'USDPayment',
                },
              },
            ],
          },
        }),
      },
    },
  });

  const gatewaySchema = stitchSchemas({
    subschemas: [
      {
        schema: GlobalStore,
        merge: {
          Order: {
            selectionSet: `{ id marketplaceId }`,
            fieldName: 'order',
            args: ({ id, marketplaceId }) => ({ id, marketplaceId }),
          },
        },
      },
      {
        schema: PaymentCareService,
        merge: {
          Order: {
            selectionSet: `{ id marketplaceId }`,
            fieldName: '_payment_order',
            args: ({ id, marketplaceId }) => ({
              key: { id, marketplaceId },
            }),
          },
        },
      },
      // Registering GlobalStore again at the end changes the resolution sequence
      {
        schema: GlobalStore,
        merge: {
          Order: {
            selectionSet: `{ id marketplaceId }`,
            fieldName: 'order',
            args: ({ id, marketplaceId }) => ({ id, marketplaceId }),
          },
        },
      },
    ],
  });

  const query = /* GraphQL */ `
    query {
      order(id: "o1", marketplaceId: "mkt1") {
        id
        transactions(first: 0) {
          paymentTransactionList {
            id
            amount
            pointsPaymentSpecificAttributes {
              pointsRate
            }
            processorDetails {
              processorName
              processorTraceIdCode
            }
            settlementVerificationCode
            statusDetails {
              partnerCustomerPaymentReference
              partnerCustomerPaymentReferenceName
            }
          }
        }
      }
    }
  `;

  const result = await graphql({
    schema: gatewaySchema,
    source: query,
  });

  expect(result).toEqual({
    data: {
      order: {
        id: 'o1',
        transactions: {
          paymentTransactionList: [
            {
              id: 't1',
              amount: 688.0, // CNY amount from GlobalStore
              // pointsPaymentSpecificAttributes is null because:
              // 1. According to delegation rules, the gateway delegates top-level queries
              //    to the last subschema that defines them
              // 2. With GlobalStore registered twice, the second registration (at the end)
              //    becomes the authoritative source for the 'order' query
              // 3. GlobalStore doesn't have pointsPaymentSpecificAttributes field
              // 4. The standard schema stitching behavior doesn't actively search for fields
              //    across all subschemas when a field is missing
              // 5. The registry order is critical for proper resolution:
              //    - Top-level 'order' query resolves from the last GlobalStore
              //    - For schema stitching with @merge, the first schema in order wins
              //    - This creates a deterministic but sensitive resolution sequence
              // 6. NOTE: PR #6117 would change this behavior to resolve pointsPaymentSpecificAttributes
              //    from PaymentCareService schema, but we deliberately maintain this behavior as per COE-325042
              pointsPaymentSpecificAttributes: null,
              processorDetails: null,
              settlementVerificationCode: null,
              statusDetails: null,
            },
          ],
        },
      },
    },
  });
});

it('resolves order paymentMethodList from GlobalStore without delegating to PaymentCareService', async () => {
  // GlobalStore schema - has order with nested fields but NOT PaymentCareService-specific fields
  const GlobalStore = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      scalar ObfuscatedMarketplaceId
      scalar OrderId
      scalar PayStationClientId
      scalar PurchaseId

      type Query {
        order(
          localizationOptions: LocalizationOptions
          obfuscatedMarketplaceId: ObfuscatedMarketplaceId!
          orderId: OrderId!
        ): Order
      }

      type Order {
        obfuscatedMarketplaceId: ObfuscatedMarketplaceId
        orderId: OrderId
        backupPaymentMethodDetails: BackupPaymentMethodDetails
        paymentMethodList(
          payStationClientId: PayStationClientId
        ): [PaymentMethod]
        purchase: Purchase
      }

      type BackupPaymentMethodDetails {
        isBackupPaymentMethodUsed: Boolean
        paymentMethod: BasicPaymentMethod
      }

      type BasicPaymentMethod {
        paymentMethodCategory: String
        paymentMethodId: String
      }

      interface PaymentMethod {
        paymentMethodCategory: String
        paymentMethodCategoryName: String
        paymentMethodId: String
        # obfuscatedCustomerId and paymentMethodReferenceData NOT defined here (PaymentCareService-only)
      }

      type CardPaymentMethod implements PaymentMethod {
        paymentMethodCategory: String
        paymentMethodCategoryName: String
        paymentMethodId: String
        # brand, cardNumberTail, coBrand, expiration NOT defined here (PaymentCareService-only)
      }

      type Purchase {
        purchaseId: PurchaseId
      }

      input LocalizationOptions {
        languageCode: String
      }
    `,
    resolvers: {
      Query: {
        order: (
          _,
          { localizationOptions, obfuscatedMarketplaceId, orderId },
        ) => ({
          obfuscatedMarketplaceId,
          orderId,
          backupPaymentMethodDetails: {
            isBackupPaymentMethodUsed: true,
            paymentMethod: {
              paymentMethodCategory: 'CARD',
              paymentMethodId: 'cny-backup-123',
            },
          },
          paymentMethodList: [
            {
              __typename: 'CardPaymentMethod',
              paymentMethodCategory: 'CARD',
              paymentMethodCategoryName: 'Credit Card CNY',
              paymentMethodId: 'cny-pm1',
            },
          ],
          purchase: {
            purchaseId: 'cny-purchase-456',
          },
        }),
      },
    },
  });

  // PaymentCareService schema - has _payment_order with PaymentCareService-specific nested fields
  const PaymentCareService = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      scalar _SchemaStitchingKey
      scalar ObfuscatedMarketplaceId
      scalar OrderId
      scalar PayStationClientId

      type Query {
        _payment_order(key: _SchemaStitchingKey!): Order
      }

      type Order {
        obfuscatedMarketplaceId: ObfuscatedMarketplaceId
        orderId: OrderId
        paymentMethodList(
          payStationClientId: PayStationClientId
        ): [PaymentMethod]
      }

      interface PaymentMethod {
        obfuscatedCustomerId: String
        paymentMethodReferenceData: PaymentMethodReferenceData
      }

      type CardPaymentMethod implements PaymentMethod {
        obfuscatedCustomerId: String
        paymentMethodReferenceData: PaymentMethodReferenceData
        brand: String
        cardNumberTail: String
        coBrand: String
        expiration: Expiration
      }

      type Expiration {
        month: Int
        year: Int
      }

      type PaymentMethodReferenceData {
        artAssetList: [ArtAsset]
        displayNameList: [DisplayName]
      }

      type ArtAsset {
        artCategory: String
        contentAltTextReferenceDescriptor: StringDescriptor
        contentUrl: String
        mimeType: String
      }

      type DisplayName {
        displayNameCategory: String
        nameReferenceDescriptor: StringDescriptor
      }

      type StringDescriptor {
        translatedText(localizationOptions: LocalizationOptions): String
      }

      input LocalizationOptions {
        languageCode: String
      }
    `,
    resolvers: {
      Query: {
        _payment_order: (_, { key }) => ({
          obfuscatedMarketplaceId: key.obfuscatedMarketplaceId,
          orderId: key.orderId,
          paymentMethodList: [
            {
              __typename: 'CardPaymentMethod',
              obfuscatedCustomerId: 'usd-cust-789',
              paymentMethodReferenceData: {
                artAssetList: [
                  {
                    artCategory: 'USD_CARD_LOGO',
                    contentAltTextReferenceDescriptor: {
                      translatedText: 'USD Card Logo Alt Text',
                    },
                    contentUrl: 'https://example.com/usd-card.png',
                    mimeType: 'image/png',
                  },
                ],
                displayNameList: [
                  {
                    displayNameCategory: 'USD_BRAND_NAME',
                    nameReferenceDescriptor: {
                      translatedText: 'USD Credit Card Brand',
                    },
                  },
                ],
              },
              brand: 'USD_VISA',
              cardNumberTail: '5678',
              coBrand: 'USD_BANK',
              expiration: { month: 11, year: 2026 },
            },
          ],
        }),
      },
    },
  });

  const gatewaySchema = stitchSchemas({
    subschemas: [
      {
        schema: GlobalStore,
        merge: {
          Order: {
            selectionSet: `{ obfuscatedMarketplaceId orderId }`,
            fieldName: 'order',
            args: ({ obfuscatedMarketplaceId, orderId }) => ({
              obfuscatedMarketplaceId,
              orderId,
            }),
          },
        },
      },
      {
        schema: PaymentCareService,
        merge: {
          Order: {
            selectionSet: `{ obfuscatedMarketplaceId orderId }`,
            fieldName: '_payment_order',
            args: ({ obfuscatedMarketplaceId, orderId }) => ({
              key: { obfuscatedMarketplaceId, orderId },
            }),
          },
        },
      },
      // Registering GlobalStore again at the end changes the resolution sequence
      {
        schema: GlobalStore,
        merge: {
          Order: {
            selectionSet: `{ obfuscatedMarketplaceId orderId }`,
            fieldName: 'order',
            args: ({ obfuscatedMarketplaceId, orderId }) => ({
              obfuscatedMarketplaceId,
              orderId,
            }),
          },
        },
      },
    ],
  });

  const query = /* GraphQL */ `
    query getOrderPaymentMethodData(
      $obfuscatedMarketplaceId: ObfuscatedMarketplaceId!
      $orderId: OrderId!
      $payStationClientId: PayStationClientId
      $shouldCallPurchase: Boolean!
    ) {
      order(
        obfuscatedMarketplaceId: $obfuscatedMarketplaceId
        orderId: $orderId
      ) {
        backupPaymentMethodDetails @include(if: $shouldCallPurchase) {
          isBackupPaymentMethodUsed
          paymentMethod {
            paymentMethodCategory
            paymentMethodId
          }
        }
        paymentMethodList(payStationClientId: $payStationClientId) {
          obfuscatedCustomerId
          paymentMethodCategory
          paymentMethodCategoryName
          paymentMethodId
          paymentMethodReferenceData {
            artAssetList {
              artCategory
              contentAltTextReferenceDescriptor {
                translatedText(localizationOptions: {})
              }
              contentUrl
              mimeType
            }
            displayNameList {
              displayNameCategory
              nameReferenceDescriptor {
                translatedText(localizationOptions: {})
              }
            }
          }
          ... on CardPaymentMethod {
            brand
            cardNumberTail
            coBrand
            expiration {
              month
              year
            }
          }
        }
        purchase @include(if: $shouldCallPurchase) {
          purchaseId
        }
      }
    }
  `;

  const result = await graphql({
    schema: gatewaySchema,
    source: query,
    variableValues: {
      obfuscatedMarketplaceId: 'mkt1',
      orderId: 'order1',
      payStationClientId: 'client1',
      shouldCallPurchase: true,
    },
  });

  expect(result).toEqual({
    data: {
      order: {
        // Fields defined in GlobalStore resolve from GlobalStore (CNY values)
        backupPaymentMethodDetails: {
          isBackupPaymentMethodUsed: true, // GlobalStore value
          paymentMethod: {
            paymentMethodCategory: 'CARD', // GlobalStore value
            paymentMethodId: 'cny-backup-123', // GlobalStore CNY value
          },
        },
        paymentMethodList: [
          {
            // PaymentCareService-specific fields return null (not in GlobalStore schema)
            obfuscatedCustomerId: null,
            // GlobalStore fields resolve successfully with CNY values
            paymentMethodCategory: 'CARD',
            paymentMethodCategoryName: 'Credit Card CNY',
            paymentMethodId: 'cny-pm1',
            // Complex nested PaymentCareService fields return null because:
            // 1. The gateway delegates the 'order' query to GlobalStore (last registration)
            // 2. GlobalStore's PaymentMethod interface doesn't include paymentMethodReferenceData
            // 3. Standard schema stitching behavior doesn't search PaymentCareService for missing fields
            // 4. Even though PaymentCareService has extensive nested data with translatedText,
            //    the delegation rules prevent automatic field resolution across subschemas
            // 5. This demonstrates the intended GlobalStore behavior: PaymentCareService-specific fields return null
            //    rather than being resolved from PaymentCareService to prevent unintended traffic
            paymentMethodReferenceData: null,
            // Inline fragment fields also return null (not in GlobalStore CardPaymentMethod)
            brand: null,
            cardNumberTail: null,
            coBrand: null,
            expiration: null,
          },
        ],
        purchase: {
          purchaseId: 'cny-purchase-456', // GlobalStore CNY value
        },
      },
    },
  });
});

it('resolves retailOrder from GlobalStore with fields only in PaymentCareService returning null', async () => {
  // GlobalStore schema - has most LineItemCostSummary fields but NOT lineItemDSBCPayment
  const GlobalStore = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      scalar ObfuscatedMarketplaceId
      scalar ObfuscatedCustomerId
      scalar OrderId

      type Query {
        retailOrder(
          obfuscatedMarketplaceId: ObfuscatedMarketplaceId!
          orderId: OrderId!
        ): RetailOrder
      }

      type RetailOrder {
        obfuscatedMarketplaceId: ObfuscatedMarketplaceId
        orderId: OrderId
        lineItemList: [LineItem]
      }

      type LineItem {
        obfuscatedLineItemId: String
        lineItemCostSummary: LineItemCostSummary
      }

      type LineItemCostSummary {
        convertedLineItemCostSummary: LineItemCostSummary
        lineItemEBTPayment: Amount
        ourPrice: Cost
        giftwrapCharge: Money
        # lineItemDSBCPayment is NOT defined here (only in PaymentCareService)
      }

      type Cost {
        price: Amount
      }

      type Amount {
        unit: String
        value: Float
      }

      type Money {
        amount: Float
        currencyCode: String
      }
    `,
    resolvers: {
      Query: {
        retailOrder: (_, { obfuscatedMarketplaceId, orderId }) => ({
          obfuscatedMarketplaceId,
          orderId,
          lineItemList: [
            {
              obfuscatedLineItemId: 'li1',
              lineItemCostSummary: {
                convertedLineItemCostSummary: {
                  lineItemEBTPayment: { unit: 'CNY', value: 68.8 },
                  ourPrice: { price: { unit: 'CNY', value: 178.81 } },
                  giftwrapCharge: { amount: 20.59, currencyCode: 'CNY' },
                },
                lineItemEBTPayment: { unit: 'CNY', value: 68.8 },
                ourPrice: { price: { unit: 'CNY', value: 178.81 } },
                giftwrapCharge: { amount: 20.59, currencyCode: 'CNY' },
              },
            },
          ],
        }),
      },
    },
  });

  // PaymentCareService schema - has lineItemDSBCPayment and other fields
  const PaymentCareService = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      scalar _SchemaStitchingKey
      scalar ObfuscatedCustomerId

      type Query {
        _payment_retailLineItem(key: _SchemaStitchingKey!): LineItem
      }

      type LineItem {
        obfuscatedLineItemId: String
        lineItemCostSummary: LineItemCostSummary
      }

      type LineItemCostSummary {
        convertedLineItemCostSummary: LineItemCostSummary
        lineItemDSBCPayment(obfuscatedCustomerId: ObfuscatedCustomerId!): Amount
        lineItemEBTPayment: Amount
        ourPrice: Cost
        giftwrapCharge: Money
      }

      type Cost {
        price: Amount
      }

      type Amount {
        unit: String
        value: Float
      }

      type Money {
        amount: Float
        currencyCode: String
      }
    `,
    resolvers: {
      Query: {
        _payment_retailLineItem: (_, { key }) => ({
          obfuscatedLineItemId: key.obfuscatedLineItemId,
          lineItemCostSummary: {
            convertedLineItemCostSummary: {
              lineItemDSBCPayment: { unit: 'USD', value: 5.0 },
              lineItemEBTPayment: { unit: 'USD', value: 15.0 },
              ourPrice: { price: { unit: 'USD', value: 30.0 } },
              giftwrapCharge: { amount: 5.0, currencyCode: 'USD' },
            },
            lineItemDSBCPayment: { unit: 'USD', value: 5.0 },
            lineItemEBTPayment: { unit: 'USD', value: 15.0 },
            ourPrice: { price: { unit: 'USD', value: 30.0 } },
            giftwrapCharge: { amount: 5.0, currencyCode: 'USD' },
          },
        }),
      },
    },
  });

  const gatewaySchema = stitchSchemas({
    subschemas: [
      {
        schema: GlobalStore,
        merge: {
          RetailOrder: {
            selectionSet: `{ obfuscatedMarketplaceId orderId }`,
            fieldName: 'retailOrder',
            args: ({ obfuscatedMarketplaceId, orderId }) => ({
              obfuscatedMarketplaceId,
              orderId,
            }),
          },
        },
      },
      {
        schema: PaymentCareService,
        merge: {
          LineItem: {
            selectionSet: `{ obfuscatedLineItemId }`,
            fieldName: '_payment_retailLineItem',
            args: ({ obfuscatedLineItemId }) => ({
              key: { obfuscatedLineItemId },
            }),
          },
        },
      },
      // Registering GlobalStore again at the end changes the resolution sequence
      {
        schema: GlobalStore,
        merge: {
          RetailOrder: {
            selectionSet: `{ obfuscatedMarketplaceId orderId }`,
            fieldName: 'retailOrder',
            args: ({ obfuscatedMarketplaceId, orderId }) => ({
              obfuscatedMarketplaceId,
              orderId,
            }),
          },
        },
      },
    ],
  });

  const query = /* GraphQL */ `
    query getRetailCustomerLineItem(
      $obfuscatedMarketplaceId: ObfuscatedMarketplaceId!
      $orderId: OrderId!
      $obfuscatedCustomerId: ObfuscatedCustomerId!
    ) {
      retailOrder(
        obfuscatedMarketplaceId: $obfuscatedMarketplaceId
        orderId: $orderId
      ) {
        lineItemList {
          obfuscatedLineItemId
          lineItemCostSummary {
            convertedLineItemCostSummary {
              ourPrice {
                price {
                  unit
                  value
                }
              }
              lineItemEBTPayment {
                unit
                value
              }
              giftwrapCharge {
                amount
                currencyCode
              }
              lineItemDSBCPayment(obfuscatedCustomerId: $obfuscatedCustomerId) {
                unit
                value
              }
            }
            lineItemEBTPayment {
              unit
              value
            }
            ourPrice {
              price {
                unit
                value
              }
            }
            giftwrapCharge {
              amount
              currencyCode
            }
          }
        }
      }
    }
  `;

  const result = await graphql({
    schema: gatewaySchema,
    source: query,
    variableValues: {
      obfuscatedMarketplaceId: 'mkt1',
      orderId: 'order1',
      obfuscatedCustomerId: 'cust1',
    },
  });

  expect(result).toEqual({
    data: {
      retailOrder: {
        lineItemList: [
          {
            obfuscatedLineItemId: 'li1',
            lineItemCostSummary: {
              convertedLineItemCostSummary: {
                // Fields defined in GlobalStore resolve from GlobalStore (not PaymentCareService)
                ourPrice: {
                  price: {
                    unit: 'CNY',
                    value: 178.81, // GlobalStore CNY value (178.81), not PaymentCareService USD value (30.00)
                  },
                },
                lineItemEBTPayment: {
                  unit: 'CNY',
                  value: 68.8, // GlobalStore CNY value (68.80), not PaymentCareService USD value (15.00)
                },
                giftwrapCharge: {
                  amount: 20.59, // GlobalStore CNY value (20.59), not PaymentCareService USD value (5.00)
                  currencyCode: 'CNY',
                },
                // lineItemDSBCPayment is null because:
                // 1. The gateway delegates the 'retailOrder' query to GlobalStore (last registration)
                // 2. GlobalStore's LineItemCostSummary type doesn't include lineItemDSBCPayment field
                // 3. Standard schema stitching behavior doesn't search PaymentCareService for missing fields
                // 4. Even though PaymentCareService has lineItemDSBCPayment with a resolver,
                //    the delegation rules prevent automatic field resolution across subschemas
                // 5. This demonstrates the intended behavior: GlobalStore takes priority for its fields,
                //    and fields not in GlobalStore return null (no PaymentCareService calls)
                lineItemDSBCPayment: null,
              },
              // Same behavior at the root level
              lineItemEBTPayment: {
                unit: 'CNY',
                value: 68.8, // GlobalStore CNY value
              },
              ourPrice: {
                price: {
                  unit: 'CNY',
                  value: 178.81, // GlobalStore CNY value
                },
              },
              giftwrapCharge: {
                amount: 20.59, // GlobalStore CNY value
                currencyCode: 'CNY',
              },
            },
          },
        ],
      },
    },
  });
});

it('resolves purchase selectedFinancialOfferList from GlobalStore without delegating to PaymentCareService', async () => {
  // GlobalStore schema - has purchase with selectedFinancialOfferList but NOT installmentsProviderDescriptor
  const GlobalStore = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      scalar ObfuscatedMarketplaceId
      scalar PurchaseId

      type Query {
        purchase(
          obfuscatedMarketplaceId: ObfuscatedMarketplaceId!
          purchaseId: PurchaseId!
        ): Purchase
      }

      type Purchase {
        obfuscatedMarketplaceId: ObfuscatedMarketplaceId
        purchaseId: PurchaseId
        selectedFinancialOfferList: [FinancialOffer]
      }

      type FinancialOffer {
        id: String
        installmentPlan: InstallmentPlan
        offerDescriptionDescriptor: StringDescriptor
      }

      type InstallmentPlan {
        firstInstallmentPaymentAmount: Money
        installmentAmount: Money
        installmentsProvider: String
        interest: Interest
        numberOfInstallments: Int
        # installmentsProviderDescriptor is NOT defined here (only in PaymentCareService)
      }

      type Money {
        amount: Float
        currencyCode: String
      }

      type Interest {
        period: String
        rate: Float
      }

      type StringDescriptor {
        hashGetParams: String
        stringId: String
        translatedText(localizationOptions: LocalizationOptions): String
      }

      input LocalizationOptions {
        languageCode: String
      }
    `,
    resolvers: {
      Query: {
        purchase: (_, { obfuscatedMarketplaceId, purchaseId }) => ({
          obfuscatedMarketplaceId,
          purchaseId,
          selectedFinancialOfferList: [
            {
              id: 'cny-offer-1',
              installmentPlan: {
                firstInstallmentPaymentAmount: {
                  amount: 68.8,
                  currencyCode: 'CNY',
                },
                installmentAmount: { amount: 137.6, currencyCode: 'CNY' },
                installmentsProvider: 'CNYBankProvider',
                interest: { period: 'MONTHLY', rate: 0.015 },
                numberOfInstallments: 6,
              },
              offerDescriptionDescriptor: {
                hashGetParams: 'cny-hash-123',
                stringId: 'cny-string-456',
                translatedText: 'CNY Financial Offer',
              },
            },
          ],
        }),
      },
    },
  });

  // PaymentCareService schema - has _payment_purchase merge query with installmentsProviderDescriptor
  const PaymentCareService = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      scalar _SchemaStitchingKey
      scalar ObfuscatedMarketplaceId
      scalar PurchaseId

      type Query {
        _payment_purchase(key: _SchemaStitchingKey!): Purchase
      }

      type Purchase {
        obfuscatedMarketplaceId: ObfuscatedMarketplaceId
        purchaseId: PurchaseId
        selectedFinancialOfferList: [FinancialOffer]
      }

      type FinancialOffer {
        installmentPlan: InstallmentPlan
      }

      type InstallmentPlan {
        installmentsProviderDescriptor: StringDescriptor
      }

      type StringDescriptor {
        translatedText(localizationOptions: LocalizationOptions): String
      }

      input LocalizationOptions {
        languageCode: String
      }
    `,
    resolvers: {
      Query: {
        _payment_purchase: (_, { key }) => ({
          obfuscatedMarketplaceId: key.obfuscatedMarketplaceId,
          purchaseId: key.purchaseId,
          selectedFinancialOfferList: [
            {
              installmentPlan: {
                installmentsProviderDescriptor: {
                  translatedText: 'USD Installments Provider Description',
                },
              },
            },
          ],
        }),
      },
    },
  });

  const gatewaySchema = stitchSchemas({
    subschemas: [
      {
        schema: GlobalStore,
        merge: {
          Purchase: {
            selectionSet: `{ obfuscatedMarketplaceId purchaseId }`,
            fieldName: 'purchase',
            args: ({ obfuscatedMarketplaceId, purchaseId }) => ({
              obfuscatedMarketplaceId,
              purchaseId,
            }),
          },
        },
      },
      {
        schema: PaymentCareService,
        merge: {
          Purchase: {
            selectionSet: `{ obfuscatedMarketplaceId purchaseId }`,
            fieldName: '_payment_purchase',
            args: ({ obfuscatedMarketplaceId, purchaseId }) => ({
              key: { obfuscatedMarketplaceId, purchaseId },
            }),
          },
        },
      },
      // Registering GlobalStore again at the end changes the resolution sequence
      {
        schema: GlobalStore,
        merge: {
          Purchase: {
            selectionSet: `{ obfuscatedMarketplaceId purchaseId }`,
            fieldName: 'purchase',
            args: ({ obfuscatedMarketplaceId, purchaseId }) => ({
              obfuscatedMarketplaceId,
              purchaseId,
            }),
          },
        },
      },
    ],
  });

  const query = /* GraphQL */ `
    query getFinancialOffers(
      $obfuscatedMarketplaceId: ObfuscatedMarketplaceId!
      $purchaseId: PurchaseId!
    ) {
      purchase(
        obfuscatedMarketplaceId: $obfuscatedMarketplaceId
        purchaseId: $purchaseId
      ) {
        selectedFinancialOfferList {
          id
          installmentPlan {
            firstInstallmentPaymentAmount {
              amount
              currencyCode
            }
            installmentAmount {
              amount
              currencyCode
            }
            installmentsProvider
            installmentsProviderDescriptor {
              translatedText(localizationOptions: {})
            }
            interest {
              period
              rate
            }
            numberOfInstallments
          }
          offerDescriptionDescriptor {
            hashGetParams
            stringId
            translatedText(localizationOptions: {})
          }
        }
      }
    }
  `;

  const result = await graphql({
    schema: gatewaySchema,
    source: query,
    variableValues: {
      obfuscatedMarketplaceId: 'mkt1',
      purchaseId: 'purchase1',
    },
  });

  expect(result).toEqual({
    data: {
      purchase: {
        selectedFinancialOfferList: [
          {
            id: 'cny-offer-1',
            installmentPlan: {
              // Fields defined in GlobalStore resolve from GlobalStore (CNY values)
              firstInstallmentPaymentAmount: {
                amount: 68.8, // CNY amount from GlobalStore
                currencyCode: 'CNY',
              },
              installmentAmount: {
                amount: 137.6, // CNY amount from GlobalStore
                currencyCode: 'CNY',
              },
              installmentsProvider: 'CNYBankProvider', // GlobalStore value
              // installmentsProviderDescriptor is null because:
              // 1. The gateway delegates the 'purchase' query to GlobalStore (last registration)
              // 2. GlobalStore's InstallmentPlan type doesn't include installmentsProviderDescriptor field
              // 3. Standard schema stitching behavior doesn't search PaymentCareService for this field
              // 4. Even though PaymentCareService has installmentsProviderDescriptor with translatedText,
              //    the delegation rules prevent automatic field resolution across subschemas
              // 5. This demonstrates the intended GlobalStore behavior: fields not in GlobalStore return null
              //    rather than being resolved from PaymentCareService to prevent unintended traffic
              installmentsProviderDescriptor: null,
              interest: {
                period: 'MONTHLY', // GlobalStore value
                rate: 0.015, // GlobalStore value
              },
              numberOfInstallments: 6, // GlobalStore value
            },
            offerDescriptionDescriptor: {
              // Fields defined in GlobalStore resolve from GlobalStore
              hashGetParams: 'cny-hash-123', // GlobalStore value
              stringId: 'cny-string-456', // GlobalStore value
              translatedText: 'CNY Financial Offer', // GlobalStore value
            },
          },
        ],
      },
    },
  });
});

it('resolves order payment transactions from GlobalStore with complex PaymentCareService fields returning null', async () => {
  // GlobalStore schema - has comprehensive order transactions but NOT pointsPaymentSpecificAttributes, processorDetails, etc.
  const GlobalStore = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      scalar ObfuscatedMarketplaceId
      scalar OrderId

      type Query {
        order(
          localizationOptions: LocalizationOptions
          obfuscatedMarketplaceId: ObfuscatedMarketplaceId!
          orderId: OrderId!
        ): Order
      }

      type Order {
        obfuscatedMarketplaceId: ObfuscatedMarketplaceId
        orderId: OrderId
        transactions(first: Int): TransactionConnection
      }

      type TransactionConnection {
        pagination: Pagination
        paymentTransactionList: [PaymentTransaction]
      }

      type Pagination {
        key: String
      }

      type PaymentTransaction {
        amazonReferenceId: String
        approvedAmount: Amount
        category: String
        completedDate: String
        convenienceStoreProcessingAttributes: ConvenienceStoreProcessingAttributes
        createdDate: String
        detailedStatusCode: String
        isPinlessDebit: Boolean
        isReplacementRetrochargeTransaction: Boolean
        paymentMethod: PaymentMethod
        paymentMethodTransactionSpecificCode: String
        requestedAmount: Amount
        status: String
        # Fields NOT defined in GlobalStore (only in PaymentCareService):
        # pointsPaymentSpecificAttributes
        # processorDetails
        # settlementVerificationCode
        # statusDetails
      }

      type Amount {
        unit: String
        value: Float
      }

      type ConvenienceStoreProcessingAttributes {
        convenienceStorePayId: String
        depositDate: String
        dueDate: String
        registrationDate: String
        statusCode: String
      }

      union PaymentMethod =
        | CardPaymentMethod
        | ZipPaymentMethod
        | PayLaterAccountPaymentMethod

      type CardPaymentMethod {
        paymentMethodCategory: String
        paymentMethodCategoryName: String
        paymentMethodId: String
        brand: String
        cardNumberTail: String
        coBrand: String
      }

      type ZipPaymentMethod {
        paymentMethodCategory: String
        paymentMethodCategoryName: String
        paymentMethodId: String
        zipAccountType: String
      }

      type PayLaterAccountPaymentMethod {
        paymentMethodCategory: String
        paymentMethodCategoryName: String
        paymentMethodId: String
        brand: String
        selectedFinancialOffer: FinancialOffer
      }

      type FinancialOffer {
        id: String
        installmentPlan: InstallmentPlan
      }

      type InstallmentPlan {
        installmentsProvider: String
      }

      input LocalizationOptions {
        languageCode: String
      }
    `,
    resolvers: {
      Query: {
        order: (
          _,
          { localizationOptions, obfuscatedMarketplaceId, orderId },
        ) => ({
          obfuscatedMarketplaceId,
          orderId,
          transactions: {
            pagination: { key: 'cny-pagination-key' },
            paymentTransactionList: [
              {
                amazonReferenceId: 'cny-ref-123',
                approvedAmount: { unit: 'CNY', value: 688.0 },
                category: 'PURCHASE',
                completedDate: '2024-01-15T10:30:00Z',
                convenienceStoreProcessingAttributes: {
                  convenienceStorePayId: 'cny-store-456',
                  depositDate: '2024-01-16T00:00:00Z',
                  dueDate: '2024-01-30T23:59:59Z',
                  registrationDate: '2024-01-15T10:30:00Z',
                  statusCode: 'REGISTERED',
                },
                createdDate: '2024-01-15T10:00:00Z',
                detailedStatusCode: 'COMPLETED_SUCCESS',
                isPinlessDebit: false,
                isReplacementRetrochargeTransaction: false,
                paymentMethod: {
                  __typename: 'CardPaymentMethod',
                  paymentMethodCategory: 'CARD',
                  paymentMethodCategoryName: 'Credit Card CNY',
                  paymentMethodId: 'cny-card-789',
                  brand: 'CNY_VISA',
                  cardNumberTail: '1234',
                  coBrand: 'CNY_BANK',
                },
                paymentMethodTransactionSpecificCode: 'CNY_AUTH_SUCCESS',
                requestedAmount: { unit: 'CNY', value: 688.0 },
                status: 'COMPLETED',
              },
            ],
          },
        }),
      },
    },
  });

  // PaymentCareService schema - has _payment_order merge query with PaymentCareService-specific fields
  const PaymentCareService = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      scalar _SchemaStitchingKey
      scalar ObfuscatedMarketplaceId
      scalar OrderId

      type Query {
        _payment_order(key: _SchemaStitchingKey!): Order
      }

      type Order {
        obfuscatedMarketplaceId: ObfuscatedMarketplaceId
        orderId: OrderId
        transactions(first: Int): TransactionConnection
      }

      type TransactionConnection {
        paymentTransactionList: [PaymentTransaction]
      }

      type PaymentTransaction {
        pointsPaymentSpecificAttributes: PointsAttributes
        processorDetails: ProcessorDetails
        settlementVerificationCode: String
        statusDetails: StatusDetails
      }

      type PointsAttributes {
        pointsRate: Float
      }

      type ProcessorDetails {
        processorName: String
        processorTraceIdCode: String
      }

      type StatusDetails {
        partnerCustomerPaymentReference: String
        partnerCustomerPaymentReferenceName: String
      }
    `,
    resolvers: {
      Query: {
        _payment_order: (_, { key }) => ({
          obfuscatedMarketplaceId: key.obfuscatedMarketplaceId,
          orderId: key.orderId,
          transactions: {
            paymentTransactionList: [
              {
                pointsPaymentSpecificAttributes: {
                  pointsRate: 0.02,
                },
                processorDetails: {
                  processorName: 'USDPaymentProcessor',
                  processorTraceIdCode: 'USD987654',
                },
                settlementVerificationCode: 'USD_SETTLE_456789',
                statusDetails: {
                  partnerCustomerPaymentReference: 'USD_PARTNER_REF',
                  partnerCustomerPaymentReferenceName: 'USD Payment Reference',
                },
              },
            ],
          },
        }),
      },
    },
  });

  const gatewaySchema = stitchSchemas({
    subschemas: [
      {
        schema: GlobalStore,
        merge: {
          Order: {
            selectionSet: `{ obfuscatedMarketplaceId orderId }`,
            fieldName: 'order',
            args: ({ obfuscatedMarketplaceId, orderId }) => ({
              obfuscatedMarketplaceId,
              orderId,
            }),
          },
        },
      },
      {
        schema: PaymentCareService,
        merge: {
          Order: {
            selectionSet: `{ obfuscatedMarketplaceId orderId }`,
            fieldName: '_payment_order',
            args: ({ obfuscatedMarketplaceId, orderId }) => ({
              key: { obfuscatedMarketplaceId, orderId },
            }),
          },
        },
      },
      // Registering GlobalStore again at the end changes the resolution sequence
      {
        schema: GlobalStore,
        merge: {
          Order: {
            selectionSet: `{ obfuscatedMarketplaceId orderId }`,
            fieldName: 'order',
            args: ({ obfuscatedMarketplaceId, orderId }) => ({
              obfuscatedMarketplaceId,
              orderId,
            }),
          },
        },
      },
    ],
  });

  const query = /* GraphQL */ `
    query getOrderPaymentTransactions(
      $obfuscatedMarketplaceId: ObfuscatedMarketplaceId!
      $orderId: OrderId!
    ) {
      order(
        obfuscatedMarketplaceId: $obfuscatedMarketplaceId
        orderId: $orderId
      ) {
        transactions(first: 0) {
          pagination {
            key
          }
          paymentTransactionList {
            amazonReferenceId
            approvedAmount {
              unit
              value
            }
            category
            completedDate
            convenienceStoreProcessingAttributes {
              convenienceStorePayId
              depositDate
              dueDate
              registrationDate
              statusCode
            }
            createdDate
            detailedStatusCode
            isPinlessDebit
            isReplacementRetrochargeTransaction
            paymentMethod {
              ... on CardPaymentMethod {
                paymentMethodCategory
                paymentMethodCategoryName
                paymentMethodId
                brand
                cardNumberTail
                coBrand
              }
            }
            paymentMethodTransactionSpecificCode
            pointsPaymentSpecificAttributes {
              pointsRate
            }
            processorDetails {
              processorName
              processorTraceIdCode
            }
            requestedAmount {
              unit
              value
            }
            settlementVerificationCode
            status
            statusDetails {
              partnerCustomerPaymentReference
              partnerCustomerPaymentReferenceName
            }
          }
        }
      }
    }
  `;

  const result = await graphql({
    schema: gatewaySchema,
    source: query,
    variableValues: {
      obfuscatedMarketplaceId: 'mkt1',
      orderId: 'order1',
    },
  });

  expect(result).toEqual({
    data: {
      order: {
        transactions: {
          pagination: {
            key: 'cny-pagination-key', // GlobalStore value
          },
          paymentTransactionList: [
            {
              // Fields defined in GlobalStore resolve from GlobalStore (CNY values)
              amazonReferenceId: 'cny-ref-123', // GlobalStore value
              approvedAmount: {
                unit: 'CNY',
                value: 688.0, // CNY amount from GlobalStore
              },
              category: 'PURCHASE', // GlobalStore value
              completedDate: '2024-01-15T10:30:00Z', // GlobalStore value
              convenienceStoreProcessingAttributes: {
                convenienceStorePayId: 'cny-store-456', // GlobalStore value
                depositDate: '2024-01-16T00:00:00Z', // GlobalStore value
                dueDate: '2024-01-30T23:59:59Z', // GlobalStore value
                registrationDate: '2024-01-15T10:30:00Z', // GlobalStore value
                statusCode: 'REGISTERED', // GlobalStore value
              },
              createdDate: '2024-01-15T10:00:00Z', // GlobalStore value
              detailedStatusCode: 'COMPLETED_SUCCESS', // GlobalStore value
              isPinlessDebit: false, // GlobalStore value
              isReplacementRetrochargeTransaction: false, // GlobalStore value
              paymentMethod: {
                paymentMethodCategory: 'CARD', // GlobalStore value
                paymentMethodCategoryName: 'Credit Card CNY', // GlobalStore value
                paymentMethodId: 'cny-card-789', // GlobalStore value
                brand: 'CNY_VISA', // GlobalStore value
                cardNumberTail: '1234', // GlobalStore value
                coBrand: 'CNY_BANK', // GlobalStore value
              },
              paymentMethodTransactionSpecificCode: 'CNY_AUTH_SUCCESS', // GlobalStore value
              // PaymentCareService-specific fields are null because:
              // 1. The gateway delegates the 'order' query to GlobalStore (last registration)
              // 2. GlobalStore's PaymentTransaction type doesn't include these PaymentCareService-specific fields
              // 3. Standard schema stitching behavior doesn't search PaymentCareService for missing fields
              // 4. Even though PaymentCareService has these fields with USD values and processors,
              //    the delegation rules prevent automatic field resolution across subschemas
              // 5. This demonstrates the intended GlobalStore behavior: fields not in GlobalStore return null
              //    rather than being resolved from PaymentCareService to prevent unintended traffic
              pointsPaymentSpecificAttributes: null,
              processorDetails: null,
              requestedAmount: {
                unit: 'CNY',
                value: 688.0, // CNY amount from GlobalStore
              },
              settlementVerificationCode: null,
              status: 'COMPLETED', // GlobalStore value
              statusDetails: null,
            },
          ],
        },
      },
    },
  });
});

it('should return null for Category.details from C Subschema via Product resolver when Category resolver is not available', async () => {
  // Test data similar to federation example
  const products = [
    { id: 'p1', pid: 'p1-pid', categoryId: 'c1' },
    { id: 'p2', pid: 'p2-pid', categoryId: 'c2' },
    { id: 'p3', pid: 'p3-pid', categoryId: 'c1' },
  ];

  const categories = [
    {
      id: 'c1',
      name: 'c1-name',
      details: {
        products: products.filter((p) => p.categoryId === 'c1').length,
      },
    },
    {
      id: 'c2',
      name: 'c2-name',
      details: {
        products: products.filter((p) => p.categoryId === 'c2').length,
      },
    },
  ];

  // A Subschema - has products query and basic Product/Category types
  const ASubschema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Query {
        products: [Product!]!
      }

      type Product {
        id: ID!
        pid: ID!
        category: Category
      }

      type Category {
        id: ID!
        name: String!
      }
    `,
    resolvers: {
      Query: {
        products: () =>
          products.map((p) => ({
            id: p.id,
            pid: p.pid,
            categoryId: p.categoryId,
          })),
      },
      Product: {
        category: (product) => {
          const category = categories.find((c) => c.id === product.categoryId);
          return category ? { id: category.id, name: category.name } : null;
        },
      },
    },
  });

  // B Subschema - has Product and Category with shared fields
  const BSubschema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Product {
        id: ID!
        pid: ID!
        category: Category
      }

      type Category {
        id: ID!
        name: String!
      }
    `,
    resolvers: {
      Product: {
        category: (product) => {
          const category = categories.find((c) => c.id === product.categoryId);
          return category ? { id: category.id, name: category.name } : null;
        },
      },
    },
  });

  // C Subschema - has Category.details and can resolve it via Product
  const CSubschema = makeExecutableSchema({
    typeDefs: /* GraphQL */ `
      type Category {
        details: CategoryDetails
      }

      type Product {
        id: ID!
        pid: ID!
        category: Category
      }

      type CategoryDetails {
        products: Int
      }
    `,
    resolvers: {
      Product: {
        category: (product) => {
          const category = categories.find((c) => c.id === product.categoryId);
          return category ? { details: category.details } : null;
        },
      },
    },
  });

  const gatewaySchema = stitchSchemas({
    subschemas: [
      {
        schema: ASubschema,
        merge: {
          Product: {
            selectionSet: `{ id pid }`,
            fieldName: 'products',
            key: ({ id, pid }) => ({ id, pid }),
            argsFromKeys: (keys) => ({}), // products query doesn't need args
          },
        },
      },
      {
        schema: BSubschema,
        merge: {
          Product: {
            selectionSet: `{ id pid }`,
          },
        },
      },
      {
        schema: CSubschema,
        merge: {
          Product: {
            selectionSet: `{ id pid }`,
          },
        },
      },
    ],
  });

  const query = /* GraphQL */ `
    query {
      products {
        id
        category {
          id
          details {
            products
          }
        }
      }
    }
  `;

  const result = await graphql({
    schema: gatewaySchema,
    source: query,
  });

  expect(result).toEqual({
    data: {
      products: [
        {
          id: 'p1',
          category: {
            id: 'c1',
            // details should be not resolved from C Subschema via Product resolver
            details: null,
          },
        },
        {
          id: 'p2',
          category: {
            id: 'c2',
            details: null,
          },
        },
        {
          id: 'p3',
          category: {
            id: 'c1',
            details: null,
          },
        },
      ],
    },
  });
});

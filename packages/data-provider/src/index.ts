import {
  CondOperator,
  QueryFilter,
  QuerySort,
  RequestQueryBuilder,
} from "@nestjsx/crud-request";
import omitBy from "lodash.omitby";
import { DataProvider } from "ra-core";
import { fetchUtils } from "react-admin";
import { stringify } from "querystring";

/**
 * Maps react-admin queries to a nestjsx/crud powered REST API
 *
 * @see https://github.com/nestjsx/crud
 *
 * @example
 *
 * import React from 'react';
 * import { Admin, Resource } from 'react-admin';
 * import crudProvider from 'ra-data-nestjsx-crud';
 *
 * import { PostList } from './posts';
 *
 * const dataProvider = crudProvider('http://localhost:3000');
 * const App = () => (
 *     <Admin dataProvider={dataProvider}>
 *         <Resource name="posts" list={PostList} />
 *     </Admin>
 * );
 *
 * export default App;
 */

const countDiff = (
  o1: Record<string, any>,
  o2: Record<string, any>
): Record<string, any> => omitBy(o1, (v, k) => o2[k] === v);

const composeFilter = (paramsFilter: any): QueryFilter[] => {
  const flatFilter = fetchUtils.flattenObject(paramsFilter);
  return Object.keys(flatFilter).map((key) => {
    const splitKey = key.split("||");

    let field = splitKey[0];
    let ops = splitKey[1];
    if (!ops) {
      if (
        typeof flatFilter[key] === "number" ||
        flatFilter[key].match(/^\d+$/)
      ) {
        ops = CondOperator.EQUALS;
      } else {
        ops = CondOperator.CONTAINS;
      }
    }

    if (field.startsWith("_") && field.includes(".")) {
      field = field.split(/\.(.+)/)[1];
    }
    return { field, operator: ops, value: flatFilter[key] } as QueryFilter;
  });
};

const composeQueryParams = (queryParams: any = {}): string => {
  return stringify(fetchUtils.flattenObject(queryParams));
};

const mergeEncodedQueries = (...encodedQueries) =>
  encodedQueries.map((query) => query).join("&");

const readFileAsDataUrl = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;

    reader.readAsDataURL(file.rawFile);
  });
}

const transformFileIntoBase64 = (files) => {
  if (Array.isArray(files)) {
    return Promise.all(
      files.map(readFileAsDataUrl));
  }
  return readFileAsDataUrl(files);
};

const getParamsWithBase64Files = async (data, base64Key) => {
  const { [base64Key]: base64, ...dataPayload } = data;
  if (!base64) {
    return data;
  }
  const files = await Object.keys(base64).reduce(async (data, key) => {
    data[key] = await transformFileIntoBase64(base64[key]);
    return data;
  }, {});
  return {
    ...dataPayload,
    ...files,
  };
};

export default (
  apiUrl: string,
  httpClient = fetchUtils.fetchJson,
  { base64Key = "base64" } = {}
): DataProvider => ({
  getList: (resource, params) => {
    const { page, perPage } = params.pagination;
    const { q: queryParams, ...filter } = params.filter || {};

    const encodedQueryParams = composeQueryParams(queryParams);
    const encodedQueryFilter = RequestQueryBuilder.create({
      filter: composeFilter(filter),
    })
      .setLimit(perPage)
      .setPage(page)
      .sortBy(params.sort as QuerySort)
      .setOffset((page - 1) * perPage)
      .query();

    const query = mergeEncodedQueries(encodedQueryParams, encodedQueryFilter);

    const url = `${apiUrl}/${resource}?${query}`;

    return httpClient(url).then(({ json }) => ({
      data: json.data,
      total: json.total,
    }));
  },

  getOne: (resource, params) => {
    return httpClient(`${apiUrl}/${resource}/${params.id}`).then(
      ({ json }) => ({
        data: json,
      })
    );
  },

  getMany: (resource, params) => {
    const query = RequestQueryBuilder.create()
      .setFilter({
        field: "id",
        operator: CondOperator.IN,
        value: `${params.ids}`,
      })
      .query();

    const url = `${apiUrl}/${resource}?${query}`;

    return httpClient(url).then(({ json }) => ({ data: json }));
  },

  getManyReference: (resource, params) => {
    const { page, perPage } = params.pagination;
    const { q: queryParams, ...otherFilters } = params.filter || {};
    const filter: QueryFilter[] = composeFilter(otherFilters);

    filter.push({
      field: params.target,
      operator: CondOperator.EQUALS,
      value: params.id,
    });

    const encodedQueryParams = composeQueryParams(queryParams);
    const encodedQueryFilter = RequestQueryBuilder.create({
      filter,
    })
      .sortBy(params.sort as QuerySort)
      .setLimit(perPage)
      .setOffset((page - 1) * perPage)
      .query();

    const query = mergeEncodedQueries(encodedQueryParams, encodedQueryFilter);

    const url = `${apiUrl}/${resource}?${query}`;

    return httpClient(url).then(({ json }) => ({
      data: json.data,
      total: json.total,
    }));
  },

  update: async (resource, params) => {
    params.data = await getParamsWithBase64Files(params.data, base64Key);
    console.log(params.data);
    // no need to send all fields, only updated fields are enough
    const data = countDiff(params.data, params.previousData);
    return httpClient(`${apiUrl}/${resource}/${params.id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }).then(({ json }) => ({ data: json }));
  },

  updateMany: async (resource, params) => {
    params.data = await getParamsWithBase64Files(params.data, base64Key);
    return Promise.all(
      params.ids.map((id) =>
        httpClient(`${apiUrl}/${resource}/${id}`, {
          method: "PUT",
          body: JSON.stringify(params.data),
        })
      )
    ).then((responses) => ({
      data: responses.map(({ json }) => json),
    }));
  },

  create: async (resource, params) => {
    params.data = await getParamsWithBase64Files(params.data, base64Key);
    return httpClient(`${apiUrl}/${resource}`, {
      method: "POST",
      body: JSON.stringify(params.data),
    }).then(({ json }) => ({
      data: { ...params.data, id: json.id },
    }));
  },

  delete: (resource, params) => {
    return httpClient(`${apiUrl}/${resource}/${params.id}`, {
      method: "DELETE",
    }).then(({ json }) => ({ data: { ...json, id: params.id } }));
  },

  deleteMany: (resource, params) => {
    return Promise.all(
      params.ids.map((id) =>
        httpClient(`${apiUrl}/${resource}/${id}`, {
          method: "DELETE",
        })
      )
    ).then((responses) => ({ data: responses.map(({ json }) => json) }));
  },
});

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const config = require('../config/config');

/**
 * 创建一个支持代理的 Axios 实例
 */
function createProxyAxios() {
  const options = {};
//   if (config.binance.useProxy && config.binance.proxyUrl) {
//     options.httpsAgent = new HttpsProxyAgent(config.binance.proxyUrl);
//   }
  return axios.create(options);
}

/**
 * 统一提取 headers
 */
function normalizeHeaders(headersOrWrapped) {
  if (!headersOrWrapped) return {};
  if (headersOrWrapped.headers) return headersOrWrapped.headers;
  return headersOrWrapped;
}

/**
 * 发送 GET 请求
 * @param {string} url 请求地址
 * @param {object} headersOrWrapped headers 或 { headers }
 */
async function proxyGet(url, headersOrWrapped = {}) {
  const headers = normalizeHeaders(headersOrWrapped);
  const instance = createProxyAxios();
  return instance.get(url, { headers });
}

/**
 * 发送 POST 请求
 */
async function proxyPost(url, data = {}, headersOrWrapped = {}) {
  const headers = normalizeHeaders(headersOrWrapped);
  const instance = createProxyAxios();
  return instance.post(url, data, { headers });
}

/**
 * 发送 DELETE 请求
 */
async function proxyDelete(url, headersOrWrapped = {}) {
  const headers = normalizeHeaders(headersOrWrapped);
  const instance = createProxyAxios();
  return instance.delete(url, { headers });
}

module.exports = {
  proxyGet,
  proxyPost,
  proxyDelete,
};

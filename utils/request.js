// utils/request.js
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const config = require('../config/config');

/**
 * 创建一个支持代理的 Axios 实例
 */
function createProxyAxios() {
  const options = {};
  if (config.binance.useProxy && config.binance.proxyUrl) {
    options.httpsAgent = new HttpsProxyAgent(config.binance.proxyUrl);
  }
  return axios.create(options);
}

/**
 * 发送 GET 请求
 * @param {string} url 请求地址
 * @param {object} headers 请求头（如 APIKEY）
 * @returns {Promise<AxiosResponse>}
 */
async function proxyGet(url, headers = {}) {
  const instance = createProxyAxios();
  return instance.get(url, { headers });
}

/**
 * 发送 POST 请求
 * @param {string} url 请求地址
 * @param {object} data 请求体
 * @param {object} headers 请求头
 * @returns {Promise<AxiosResponse>}
 */
async function proxyPost(url, data = {}, headers = {}) {
  const instance = createProxyAxios();
  return instance.post(url, data, { headers });
}

/**
 * 发送 DELETE 请求
 * @param {string} url 请求地址
 * @param {object} headers 请求头
 * @returns {Promise<AxiosResponse>}
 */
async function proxyDelete(url, headers = {}) {
  const instance = createProxyAxios();
  return instance.delete(url, { headers });
}

module.exports = {
  proxyGet,
  proxyPost,
  proxyDelete,
};

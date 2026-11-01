# TMP File Mirror API

TMP 更新工具使用公开的 TMP File Mirror 服务获取文件清单和文件内容。

## 基础地址

```text
https://tmplistoss.bgydook.cn
```

完整在线文档：<https://tmplistoss.bgydook.cn/docs/>

## 查询文件清单

```http
GET /api/tmp/files
Accept: application/json
```

成功响应示例：

```json
{
  "code": 200,
  "msg": "success",
  "data": [
    {
      "type": 0,
      "typeName": "系统文件",
      "filePath": "/base.scs",
      "fileSize": 123456,
      "md5": "0123456789abcdef0123456789abcdef",
      "downloadUrl": "https://tmplistoss.bgydook.cn/files/base.scs",
      "updateTime": "2026-11-01T00:00:00Z"
    }
  ]
}
```

客户端会校验 `code`、`data`、`filePath`、`fileSize` 和 `md5`，并拒绝不以 `/` 开头或包含 `..` 的路径。

## 下载文件

如果清单提供 `downloadUrl`，直接使用该地址；否则根据文件路径拼接：

```text
GET /files/{filePath}?v={md5}
```

路径中的每一段必须进行 URL 编码。`v` 参数使用清单里的 MD5，用于缓存失效和版本校验。

示例：

```text
https://tmplistoss.bgydook.cn/files/base.scs?v=0123456789abcdef0123456789abcdef
```

## 错误处理

| HTTP 状态 | 含义 |
| --- | --- |
| `200` | 请求成功 |
| `403` | 当前 IP 被限制访问 |
| `429` | 请求过于频繁，需要稍后重试 |
| 其他状态 | 服务端或网关错误 |

服务端返回的 JSON `msg` 会作为错误信息的一部分展示给客户端。

## 兼容说明

接口不需要登录令牌。请控制请求频率，不要批量抓取超出实际更新需要的文件。下载后的文件由客户端使用 MD5 再次校验。

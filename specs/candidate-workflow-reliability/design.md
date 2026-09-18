# 技术设计

前端在 `public/app-v2.js` 中维护岗位分配元数据、竞品公司名、原始简历元数据和推荐理由；原始简历通过 CloudBase Web SDK `uploadFile/getTempFileURL` 处理。云函数在 `cloudfunctions/acecall-api/index.js` 中优先使用网关注入的有效身份，SDK身份仅作为回退。简历文件只保存 `fileID`、文件名、类型和大小，不保存永久公网链接。

当前环境为传统 NoSQL CloudBase，浏览器上传要求存储桶具备受控写入权限；现有 `READONLY` 权限需在发布前调整为已登录用户可上传/读取的安全规则。

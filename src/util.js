// Utils
const utf8ToBase64 = (utf8String) => {
    return Buffer.from(utf8String, "utf8").toString("base64");
};
const base64ToUtf8 = (base64String) => {
    return Buffer.from(base64String, "base64").toString("utf8");
};

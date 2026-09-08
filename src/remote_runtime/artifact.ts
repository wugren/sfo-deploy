/** 控制端封装进部署包的固定、单文件目标运行时 identity。 */

export const REMOTE_CONFIG_UPDATER_SOURCE: string = new URL(
  "./config_updater.bundle.js",
  import.meta.url,
).pathname;

/** 保持既有远端成员名；内容是已锁定依赖的单文件 JavaScript。 */
export const REMOTE_CONFIG_UPDATER_BUNDLE_PATH: string = "sfo-config-updater.ts";
/** 内置版本化发布脚本；由 planning 注入到 App deploy 步骤。 */
export const REMOTE_VERSIONED_RELEASE_SOURCE: string = new URL(
  "./versioned_release.ts",
  import.meta.url,
).pathname;
export const REMOTE_VERSIONED_RELEASE_BUNDLE_PATH: string = "sfo-versioned-release.ts";
export const VERSIONED_RELEASE_PERMISSIONS = Object.freeze({
  run: Object.freeze([
    "/usr/bin/cat",
    "/usr/bin/chmod",
    "/usr/bin/cp",
    "/usr/bin/find",
    "/usr/bin/install",
    "/usr/bin/ln",
    "/usr/bin/ls",
    "/usr/bin/mkdir",
    "/usr/bin/mv",
    "/usr/bin/readlink",
    "/usr/bin/rm",
    "/usr/bin/test",
  ]),
  net: Object.freeze([]),
});

---
task_manifest: task.yaml
status: approved
---

# jx-server 服务配置提案

## Workflow Tier Judgment

- Proposed tier: standard
- Final tier: standard
- 层级理由：局部修改 Multipass 示例的服务启动参数和配置加载约定；沿用现有 systemd 生命周期和版本发布机制，不修改框架、生产环境或执行部署，无已确认的重大风险边界。
- 提案及层级确认：用户于 2026-09-09 回复“确认”，批准本提案及 standard 层级。

## Background and Goal

根据用户 run.sh，将服务入口改为 base-entry.jar，保留内存、时区及 GC 调优意图，并加载 application.yml 和 application-local.yml。

## Scope

- 更新 cluster-template 与本地 clusters/multipass 中 jx-server/app.yaml，补充相关使用说明。
- 工作目录使用源码内置发布机制的 latest，配置由应用制品携带，假设两个 YAML 位于 JAR 内默认配置目录或包根目录/config 子目录；不编造业务配置内容。
- 默认启用 local profile；沿用声明的 JRE 11，将旧 GC 日志参数换为统一日志参数。
- 非目标：修改制品版本、机器放置、环境安装、框架实现或执行远程部署。

## Requirement Review

- systemd 直接管理前台 Java 进程，无需 run.sh 的 nohup、PID 搜索和循环停止逻辑。
- -Dloader.path 作为 JVM 系统属性放在 -jar 前，保留 resources,lib；实际效果取决于 JAR 是否使用支持 loader.path 的启动器。
- local profile 是根据两个配置文件命名作出的提案假设，用户可在确认时修改。
- 尚未获取 JAR 和 YAML 内容；不能据此证明业务服务能启动，配置文件不在默认位置时需调整路径。
- 待澄清问题：无强制阻塞项；以上假设随本提案一并供用户确认。

## Proposal Items

| proposal_id | change_id | requirement | boundary | tradeoff | success_evidence | non_goal |
| --- | --- | --- | --- | --- | --- | --- |
| P-001 | CHG-jx-server-service-config | 生成 base-entry.jar 的 systemd 服务配置及两个 YAML 的加载约定 | Multipass 示例及本地副本 | 使用已声明 JRE 11，local profile，保留 systemd 托管 | 本地 validate、plan 与服务命令核对 | 不部署、不虚构业务 YAML |

### 待写入的完整 app.yaml

```yaml
schema_version: 4
name: jx-server
install_directory: /home/ubuntu/eleph-server
depends_on: [jre, mysql, redis]
deployment:
  kind: versioned
scripts: {}
management:
  run_as: ubuntu
  actions:
    - kind: service
      type: systemd
      unit: jx-server.service
      enabled: true
      daemon_reload: true
      on_deploy: restart
      timeout_ms: 30000
      unit_config:
        working_directory: latest
        command: /usr/bin/java
        args:
          - -Dname=base-entry.jar
          - -Duser.timezone=Asia/Shanghai
          - -Xms512m
          - -Xmx1024m
          - -XX:MetaspaceSize=128m
          - -XX:MaxMetaspaceSize=512m
          - -XX:+HeapDumpOnOutOfMemoryError
          - '-Xlog:gc*:stdout:time,uptime,level,tags'
          - -XX:NewRatio=1
          - -XX:SurvivorRatio=30
          - -XX:+UseParallelGC
          - -XX:+UseParallelOldGC
          - -Dloader.path=resources,lib
          - -jar
          - base-entry.jar
          - --spring.profiles.active=local
```

## Success Criteria

- 两份配置使用正确 JAR、latest 工作目录、JVM 参数和 local profile，保留原有服务管理策略。
- validate 与 plan 本地检查通过，核对生成服务命令；若现有外部输入阻塞验证，明确列出。
- 完成 standard 变更记录、独立缺陷发现与完成报告。
- 不将配置校验视为远端 Java 或业务健康验收。

## Risks

- 实际 Java 版本、JAR 启动器以及配置位置未实物验证。
- local 会覆盖基础配置中的同名配置项，需要使用者确认其适用于该集群。
- OOM dump 使用 JVM 默认目录，写入权限与磁盘容量属于实际运行验收边界。

参考：[Java 11 参数](https://docs.oracle.com/en/java/javase/11/tools/java.html)、[Spring Boot 配置加载](https://docs.spring.io/spring-boot/reference/features/external-config.html)。

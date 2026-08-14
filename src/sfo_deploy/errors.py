"""sfo-deploy 的稳定错误类别。"""

from __future__ import annotations


class DeploymentError(Exception):
    """所有可预期部署错误的基类。"""


class ConfigurationError(DeploymentError):
    """集群配置、引用或路径不合法。"""


class PlanningError(DeploymentError):
    """无法生成安全且确定的执行计划。"""


class PreflightError(DeploymentError):
    """执行副作用前的本地或远端预检失败。"""


class DownloadError(DeploymentError):
    """包下载或完整性校验失败。"""


class TransportError(DeploymentError):
    """SSH 连接、传输或远端命令失败。"""


class ExecutionError(DeploymentError):
    """部署步骤或清理失败。"""

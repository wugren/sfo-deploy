"""sfo-deploy public API."""

from .config import load_cluster
from .downloads import (
    DownloadProvider,
    DownloadProviderRegistry,
    DownloadRequest,
    HttpDownloadProvider,
    VerifiedArtifact,
)
from .errors import (
    ConfigurationError,
    DeploymentError,
    DownloadError,
    ExecutionError,
    PlanningError,
    PreflightError,
    TransportError,
)
from .integration import RunOptions, ValidationResult, create_cli, run
from .planning import build_plan, resolve_machine
from .remote_context import DeploymentContext
from .results import DeploymentResult, StepResult, StepStatus, TargetResult
from .secrets import ProjectBindings
from .transport import ParamikoTransport, RemoteSession, SSHTransport

__all__ = [
    "ConfigurationError",
    "DeploymentContext",
    "DeploymentError",
    "DeploymentResult",
    "DownloadError",
    "DownloadProvider",
    "DownloadProviderRegistry",
    "DownloadRequest",
    "ExecutionError",
    "HttpDownloadProvider",
    "ParamikoTransport",
    "PlanningError",
    "PreflightError",
    "ProjectBindings",
    "RemoteSession",
    "RunOptions",
    "SSHTransport",
    "StepResult",
    "StepStatus",
    "TargetResult",
    "TransportError",
    "ValidationResult",
    "VerifiedArtifact",
    "build_plan",
    "create_cli",
    "load_cluster",
    "resolve_machine",
    "run",
]

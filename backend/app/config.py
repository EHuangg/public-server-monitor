from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    glances_base_url: str = Field(default="http://collector:61208")
    glances_endpoint: str = Field(default="/api/3/all")
    request_timeout_seconds: float = Field(default=3.0)
    cache_ttl_seconds: int = Field(default=5)
    allowed_origins: str = Field(default="http://localhost:3000")

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


settings = Settings()

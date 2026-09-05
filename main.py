from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse, JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from infrastructure.routers.api_router import router as tournament_router
from infrastructure.routers.youtube_router import router as youtube_router
from infrastructure.routers.dashboard_router import router as dashboard_router
from infrastructure.routers.auth_router import router as auth_router
from infrastructure.routers.club_router import router as club_router
from infrastructure.routers.operator_auth import (
    operator_router, OperatorAuthRequiredError, OperatorForbiddenError,
)
from infrastructure.templates import templates

from dotenv import load_dotenv

load_dotenv()

app = FastAPI(
    title="Clean Architecture Tournament App",
    description="FastAPI + Firebase Firestore backend boilerplate.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_headers=["*"],
    allow_methods=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")

app.include_router(tournament_router, prefix="/api")
app.include_router(youtube_router)
app.include_router(dashboard_router, prefix="/dashboard")
app.include_router(auth_router)
app.include_router(club_router)
app.include_router(operator_router)


def _is_api_request(request: Request) -> bool:
    return request.url.path.startswith("/api")


@app.exception_handler(OperatorAuthRequiredError)
async def operator_auth_required_handler(request: Request, exc: OperatorAuthRequiredError):
    """Not an operator at all — treat like an anonymous visitor: bounce
    home quietly, exactly like a 404 would. On /api, return real JSON."""
    if _is_api_request(request):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)


@app.exception_handler(OperatorForbiddenError)
async def operator_forbidden_handler(request: Request, exc: OperatorForbiddenError):
    """A real operator hit something above their role — show an explicit
    'not authorized' page instead of pretending the page doesn't exist."""
    if _is_api_request(request):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return templates.TemplateResponse(
        request, "dashboard/403.html", {"request": request, "detail": exc.detail},
        status_code=status.HTTP_403_FORBIDDEN,
    )


@app.exception_handler(StarletteHTTPException)
async def custom_http_exception_handler(request: Request, exc: StarletteHTTPException):
    # /api is consumed by fetch()/JS — needs real status codes + JSON,
    # never a silent redirect, or error handling in the frontend breaks
    # (every 403/404/409 was previously coming back as a 200 redirect).
    if _is_api_request(request):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})

    if exc.status_code == status.HTTP_404_NOT_FOUND:
        return RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)

    return RedirectResponse(url="/")
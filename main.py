from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from infrastructure.routers.api_router import router as tournament_router
from infrastructure.routers.youtube_router import router as youtube_router
from infrastructure.routers.dashboard_router import router as dashboard_router
from infrastructure.routers.auth_router import router as auth_router
from infrastructure.routers.club_router import router as club_router

from dotenv import load_dotenv

load_dotenv()

app = FastAPI(
    title="Clean Architecture Tournament App",
    description="FastAPI + Firebase Firestore backend boilerplate.",
    version="1.0.0"
)

# Enable CORS for frontend consumption (Form, Dashboard, UI pages)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_headers=["*"],
    allow_methods=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")

# Register routes
app.include_router(tournament_router, prefix="/api")
app.include_router(youtube_router)
app.include_router(dashboard_router, prefix="/dashboard")
app.include_router(auth_router)
app.include_router(club_router)


@app.exception_handler(StarletteHTTPException)
async def custom_http_exception_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == status.HTTP_404_NOT_FOUND:
        # Redirect the user to the dashboard
        return RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)
    
    # Return default behavior for other HTTP errors (403, 500, etc.)
    return RedirectResponse(url="/")
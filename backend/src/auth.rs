use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};

use crate::AppState;

#[derive(Deserialize)]
pub struct LoginRequest {
    username: String,
    password: String,
}

#[derive(Serialize, Deserialize)]
pub struct Claims {
    sub: String,
    exp: i64,
    iat: i64,
}

#[derive(Serialize)]
pub struct LoginResponse {
    success: bool,
    token: Option<String>,
}

pub fn validate_jwt_token(token: &str, jwt_secret: &str) -> bool {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(jwt_secret.as_ref()),
        &Validation::default(),
    )
    .is_ok()
}

pub async fn login(State(state): State<AppState>, Json(payload): Json<LoginRequest>) -> impl IntoResponse {
    if payload.username == state.username && payload.password == state.password {
        // Create JWT token with 1-hour expiration
        let now = Utc::now();
        let exp = now + Duration::hours(1);
        
        let claims = Claims {
            sub: payload.username,
            exp: exp.timestamp(),
            iat: now.timestamp(),
        };
        
        match encode(
            &Header::default(),
            &claims,
            &EncodingKey::from_secret(state.jwt_secret.as_ref()),
        ) {
            Ok(token) => {
                return (StatusCode::OK, Json(LoginResponse { 
                    success: true, 
                    token: Some(token) 
                })).into_response();
            }
            Err(_) => {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            }
        }
    }

    (StatusCode::UNAUTHORIZED, Json(LoginResponse { 
        success: false, 
        token: None 
    })).into_response()
}

pub async fn require_basic_auth(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());

    // Check for JWT Bearer token
    if let Some(auth) = auth_header {
        if auth.starts_with("Bearer ") {
            let token = &auth[7..];
            if validate_jwt_token(token, &state.jwt_secret) {
                return next.run(request).await;
            }

            return StatusCode::UNAUTHORIZED.into_response();
        }
    }

    // Fall back to Basic Auth
    let credentials = auth_header
        .and_then(parse_basic_auth);

    match credentials {
        Some((username, password)) if username == state.username && password == state.password => {
            next.run(request).await
        }
        _ => StatusCode::UNAUTHORIZED.into_response(),
    }
}

pub async fn refresh_token(State(state): State<AppState>, headers: axum::http::HeaderMap) -> impl IntoResponse {
    let auth_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());

    let username = match auth_header {
        Some(auth) if auth.starts_with("Bearer ") => {
            let token = &auth[7..];
            match decode::<Claims>(
                token,
                &DecodingKey::from_secret(state.jwt_secret.as_ref()),
                &Validation::default(),
            ) {
                Ok(data) => data.claims.sub,
                Err(_) => return StatusCode::UNAUTHORIZED.into_response(),
            }
        }
        _ => return StatusCode::UNAUTHORIZED.into_response(),
    };

    let now = Utc::now();
    let exp = now + Duration::hours(1);
    let claims = Claims {
        sub: username,
        exp: exp.timestamp(),
        iat: now.timestamp(),
    };

    match encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_ref()),
    ) {
        Ok(token) => (StatusCode::OK, Json(LoginResponse { success: true, token: Some(token) })).into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

pub fn parse_basic_auth(value: &str) -> Option<(String, String)> {
    let encoded = value.strip_prefix("Basic ")?;
    let decoded = STANDARD.decode(encoded).ok()?;
    let decoded_str = String::from_utf8(decoded).ok()?;
    let (username, password) = decoded_str.split_once(':')?;
    Some((username.to_string(), password.to_string()))
}

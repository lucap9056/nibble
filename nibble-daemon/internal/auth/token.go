package auth

import (
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const issuer = "nibbled"

func Issue(key []byte, ttl time.Duration, now time.Time) (string, error) {
	expiry := now.Add(ttl)
	issuedAt := jwt.NewNumericDate(now)
	expiresAt := jwt.NewNumericDate(expiry)
	claims := jwt.RegisteredClaims{
		Issuer:    issuer,
		IssuedAt:  issuedAt,
		ExpiresAt: expiresAt,
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(key)
}

func Verify(key []byte, tokenString string) error {
	validMethods := []string{jwt.SigningMethodHS256.Name}
	methodOption := jwt.WithValidMethods(validMethods)
	issuerOption := jwt.WithIssuer(issuer)
	expirationOption := jwt.WithExpirationRequired()
	issuedAtOption := jwt.WithIssuedAt()
	parser := jwt.NewParser(methodOption, issuerOption, expirationOption, issuedAtOption)

	var claims jwt.RegisteredClaims
	keyFunc := func(*jwt.Token) (any, error) { return key, nil }
	_, err := parser.ParseWithClaims(tokenString, &claims, keyFunc)
	return err
}

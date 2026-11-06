throwaway RSA keypairs, test-only, never used to sign a real package
public-distributor.* and partner-distributor.*: leaf + a fake "VD DEVELOPER Public/Partner CA Class" issuer, the names TV-Store reads the level from (#50); partner-author.*: the Partner profile has its own author
duid-distributor.*: a distributor leaf whose subjectAltName lists two DUIDs as URN:tizen:deviceid=, the way Apps2Samsung and Samsung write them (#78)

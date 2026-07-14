# Security policy

Please report suspected vulnerabilities privately through GitHub Security Advisories for this repository. Do not open a public issue containing exploit details.

The package executes user-supplied schema SQL inside an embedded PostgreSQL instance. Applications should only provide trusted schema artifacts. The package does not require or accept production database credentials for normal generation.

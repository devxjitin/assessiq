# Code execution for coding questions: a separate x86 host running Judge0 CE.
#
# Why separate: the app host is ARM (Graviton) and the Judge0 image is x86-only, and student code
# should not run next to the database credentials. The host accepts connections on port 2358 from
# the app host only; the sandbox itself has no outbound network access (ENABLE_NETWORK=false).
# Off by default: set enable_judge0 = true to create it.

data "aws_ssm_parameter" "al2023_x86" {
  count = var.enable_judge0 ? 1 : 0
  name  = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_security_group" "judge0" {
  count       = var.enable_judge0 ? 1 : 0
  name        = "${local.name}-judge0"
  description = "Judge0 code execution host"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Judge0 API from the app host only"
    from_port       = 2358
    to_port         = 2358
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  # Outbound is needed to pull container images and for SSM; student code itself is network-isolated.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name}-judge0-sg" }
}

resource "aws_iam_role" "judge0" {
  count              = var.enable_judge0 ? 1 : 0
  name               = "${local.name}-judge0"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "judge0_ssm" {
  count      = var.enable_judge0 ? 1 : 0
  role       = aws_iam_role.judge0[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "judge0" {
  count = var.enable_judge0 ? 1 : 0
  name  = "${local.name}-judge0"
  role  = aws_iam_role.judge0[0].name
}

resource "aws_instance" "judge0" {
  count                  = var.enable_judge0 ? 1 : 0
  ami                    = data.aws_ssm_parameter.al2023_x86[0].value
  instance_type          = var.judge0_instance_type
  subnet_id              = aws_subnet.public[0].id
  vpc_security_group_ids = [aws_security_group.judge0[0].id]
  iam_instance_profile   = aws_iam_instance_profile.judge0[0].name

  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1 # containers must not reach the instance role
  }

  root_block_device {
    volume_type = "gp3"
    volume_size = 30
    encrypted   = true
  }

  # Judge0 keeps its own Postgres and Redis inside this host; nothing here is shared with the app.
  # MAX_MEMORY_LIMIT is raised because the app uses per-process limits (see JUDGE0_LIMIT_MODE),
  # and Node.js and Java reserve a lot of address space they do not use.
  user_data = <<-EOT
    #!/bin/bash
    set -euxo pipefail
    dnf install -y docker
    systemctl enable --now docker
    mkdir -p /usr/local/lib/docker/cli-plugins /opt/judge0
    curl -SL "https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-x86_64" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    cd /opt/judge0
    DB_PASS=$(openssl rand -hex 16)
    cat > docker-compose.yml <<YML
    services:
      server:
        image: judge0/judge0:1.13.1
        restart: unless-stopped
        privileged: true
        ports: ['2358:2358']
        environment: &env
          REDIS_HOST: redis
          POSTGRES_HOST: db
          POSTGRES_DB: judge0
          POSTGRES_USER: judge0
          POSTGRES_PASSWORD: $${DB_PASS}
          ENABLE_NETWORK: 'false'
          MAX_MEMORY_LIMIT: '4000000'
          MAX_CPU_TIME_LIMIT: '15'
          MAX_QUEUE_SIZE: '200'
        depends_on: [db, redis]
      workers:
        image: judge0/judge0:1.13.1
        restart: unless-stopped
        command: ['./scripts/workers']
        privileged: true
        environment: *env
        depends_on: [db, redis]
      db:
        image: postgres:16-alpine
        restart: unless-stopped
        environment:
          POSTGRES_DB: judge0
          POSTGRES_USER: judge0
          POSTGRES_PASSWORD: $${DB_PASS}
        volumes: [db_data:/var/lib/postgresql/data]
      redis:
        image: redis:7-alpine
        restart: unless-stopped
    volumes:
      db_data:
    YML
    docker compose up -d
  EOT

  lifecycle {
    ignore_changes = [ami, user_data]
  }

  tags = { Name = "${local.name}-judge0" }
}

output "judge0_url" {
  description = "Set this as JUDGE0_URL (SSM parameter) together with CODE_RUNNER=judge0."
  value       = var.enable_judge0 ? "http://${aws_instance.judge0[0].private_ip}:2358" : null
}

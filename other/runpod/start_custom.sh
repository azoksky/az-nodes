#!/bin/bash
set -e  # Exit the script if any statement returns a non-true return value

# ---------------------------------------------------------------------------- #
#                          Function Definitions                                #
# ---------------------------------------------------------------------------- #

# Start nginx service
start_nginx() {
    echo "Starting Nginx service azok azok azok azok azok azok azok..."
    service nginx start
}

# Execute script if exists
execute_script() {
    local script_path=$1
    local script_msg=$2
    if [[ -f ${script_path} ]]; then
        echo "${script_msg}"
        bash ${script_path}
    fi
}

# ---------------------------------------------------------------------------- #
#                              ssh setup                                   #
# ---------------------------------------------------------------------------- #

setup_ssh() {
    if [[ $PUBLIC_KEY ]]; then
        echo "Setting up SSH..."
        mkdir -p ~/.ssh
        echo "$PUBLIC_KEY" >> ~/.ssh/authorized_keys
        chmod 700 -R ~/.ssh

         if [ ! -f /etc/ssh/ssh_host_rsa_key ]; then
            ssh-keygen -t rsa -f /etc/ssh/ssh_host_rsa_key -q -N ''
            echo "RSA key fingerprint:"
            ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub
        fi

        if [ ! -f /etc/ssh/ssh_host_dsa_key ]; then
            ssh-keygen -t dsa -f /etc/ssh/ssh_host_dsa_key -q -N ''
            echo "DSA key fingerprint:"
            ssh-keygen -lf /etc/ssh/ssh_host_dsa_key.pub
        fi

        if [ ! -f /etc/ssh/ssh_host_ecdsa_key ]; then
            ssh-keygen -t ecdsa -f /etc/ssh/ssh_host_ecdsa_key -q -N ''
            echo "ECDSA key fingerprint:"
            ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub
        fi

        if [ ! -f /etc/ssh/ssh_host_ed25519_key ]; then
            ssh-keygen -t ed25519 -f /etc/ssh/ssh_host_ed25519_key -q -N ''
            echo "ED25519 key fingerprint:"
            ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
        fi

        service ssh start

        echo "SSH host keys:"
        for key in /etc/ssh/*.pub; do
            echo "Key: $key"
            ssh-keygen -lf $key
        done
    fi
}

# Export env vars
export_env_vars() 
{
    echo "Exporting environment variables..."
    # Persist selected vars to /etc/rp_environment
    printenv | grep -E '^RUNPOD_|^PATH=|^_=' | \
      awk -F = '{ printf("export %s=\"%s\"\n", $1, $2) }' >> /etc/rp_environment
    echo 'source /etc/rp_environment' >> ~/.bashrc

    local out="/etc/profile.d/10-container-env.sh"
    local src="/proc/1/environ"
    [ -r "$src" ] || src="/proc/self/environ"

    local tmp; tmp="$(mktemp "${out}.XXXXXX")"
    {
        tr '\0' '\n' < "$src" | awk '{
            name=$0; sub(/=.*/, "", name);
            val=$0; sub(/^[^=]*=/, "", val);
            gsub(/\\/,"\\\\",val); gsub(/"/,"\\\"",val);
            gsub(/\$/,"\\$",val); gsub(/`/,"\\`",val);
            printf("if [ -z \"${%s+x}\" ]; then export %s=\"%s\"; fi\n", name, name, val)
        }'
    } > "$tmp"
    mv -f "$tmp" "$out"
    # Add reference to /etc/rp_environment if not already there
    grep -qxF 'source /etc/rp_environment' "$out" || echo 'source /etc/rp_environment' >> "$out"
    chmod 0644 "$out"
}


# Start jupyter lab
start_jupyter() {
    if [[ $JUPYTER_PASSWORD ]]; then
        echo "Starting Jupyter Lab..."
        mkdir -p /workspace && \
        cd / && \
        nohup python3.11 -m jupyter lab --allow-root --no-browser --port=8888 --ip=* --FileContentsManager.delete_to_trash=False --ServerApp.terminado_settings='{"shell_command":["/bin/bash"]}' --ServerApp.token='' --ServerApp.password='' --ServerApp.allow_origin=* --ServerApp.preferred_dir=/workspace &> /jupyter.log &
        echo "Jupyter Lab started"
    fi
}

# ---------------------------------------------------------------------------- #
#                               Main Program                                   #
# ---------------------------------------------------------------------------- #

start_nginx
export_env_vars
setup_ssh
start_jupyter

# If unset or empty, skip bootstrap and keep the container alive
BOOTSTRAP_URL="${BOOTSTRAP_URL:-}"

if [[ -z "$BOOTSTRAP_URL" ]]; then
  echo "Start script(s) finished, pod is ready to use."
  sleep infinity
fi

echo "Fetching bootstrap from: $BOOTSTRAP_URL"

# Choose temp name based on URL extension
if [[ "$BOOTSTRAP_URL" == *.py ]]; then
  TMP_BOOT="$(mktemp /tmp/bootstrap.XXXXXX.py)"
  RUN_MODE="python"
elif [[ "$BOOTSTRAP_URL" == *.sh ]]; then
  TMP_BOOT="$(mktemp /tmp/bootstrap.XXXXXX.sh)"
  RUN_MODE="bash"
else
  echo "⚠ Unsupported bootstrap URL extension (need .sh or .py). Skipping execution."
  echo "Start script(s) finished, pod is ready to use."
  sleep infinity
fi

# Fetch with a couple retries and timeouts; follow redirects
curl -fsSL --retry 3 --connect-timeout 15 --max-time 300 "$BOOTSTRAP_URL" -o "$TMP_BOOT"

# Safety: normalize CRLF → LF (no-op if already LF)
sed -i 's/\r$//' "$TMP_BOOT" || true

# Execute according to type
echo "Executing bootstrap ($RUN_MODE): $TMP_BOOT"
if [[ "$RUN_MODE" == "bash" ]]; then
  chmod +x "$TMP_BOOT"
  bash "$TMP_BOOT"
elif [[ "$RUN_MODE" == "python" ]]; then
  python3 -u "$TMP_BOOT"
fi

# If the bootstrap returns (didn't exec), keep the pod alive
echo "Start script(s) finished, pod is ready to use."
sleep infinity


import logging
import os
from datetime import datetime
from flask import Flask, render_template, jsonify, request, flash, redirect, url_for
import requests

# Configure logging with more detail
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)

# setup a secret key, required by sessions
app.secret_key = os.environ.get("FLASK_SECRET_KEY") or "development_key"

# API configuration
API_BASE = 'https://code-api.frohrer.com/api/v2'
API_HEADERS = {
    "Content-Type": "application/json",
    "CF-Access-Client-Id": "331ebaf1a65b2d26ef48df7313337f44.access",
    "CF-Access-Client-Secret": "6e6628f68454ac2bde2ba36fe7d57636983050c5aa151d9e90a1cf18bca7f9f8"
}

@app.route('/')
def index():
    """Render the main dashboard page."""
    try:
        logger.debug("Rendering index page")
        return render_template('index.html')
    except Exception as e:
        logger.error(f"Error rendering index page: {e}", exc_info=True)
        return "Internal Server Error", 500

@app.route('/ide')
def ide():
    """Render the IDE page."""
    try:
        logger.debug("Rendering IDE page")
        return render_template('ide.html')
    except Exception as e:
        logger.error(f"Error rendering IDE page: {e}", exc_info=True)
        return "Internal Server Error", 500

@app.route('/api/runtimes')
def get_runtimes():
    """Get available runtime environments."""
    try:
        response = requests.get(f'{API_BASE}/runtimes', headers=API_HEADERS, timeout=5)
        response.raise_for_status()
        return jsonify(response.json())
    except requests.exceptions.RequestException as e:
        logger.error(f"API request error: {str(e)}", exc_info=True)
        return jsonify({"error": str(e)}), 503
    except Exception as e:
        logger.error(f"Error fetching runtimes: {e}", exc_info=True)
        return jsonify({"error": "Failed to fetch runtimes"}), 500

@app.route('/api/execute', methods=['POST'])
def execute_code():
    """Execute code in the specified runtime environment."""
    try:
        request_data = request.get_json()
        logger.debug(f"Executing code with data: {request_data}")

        response = requests.post(
            f'{API_BASE}/execute',
            headers=API_HEADERS,
            json=request_data,
            timeout=30
        )
        response.raise_for_status()
        return jsonify(response.json())
    except requests.exceptions.RequestException as e:
        logger.error(f"API request error: {str(e)}", exc_info=True)
        return jsonify({"error": str(e)}), 503
    except Exception as e:
        logger.error(f"Error executing code: {e}", exc_info=True)
        return jsonify({"error": "Failed to execute code"}), 500

@app.route('/api/metrics')
def get_metrics():
    """Fetch and return system metrics."""
    try:
        logger.debug(f"Fetching metrics from {API_BASE}/metrics")
        logger.debug(f"Using headers: {API_HEADERS}")
        response = requests.get(f'{API_BASE}/metrics', headers=API_HEADERS, timeout=5)
        response.raise_for_status()
        data = response.json()
        logger.debug(f"Received metrics data: {data}")
        return jsonify(data)
    except requests.exceptions.RequestException as e:
        logger.error(f"API request error: {str(e)}", exc_info=True)
        return jsonify({"error": str(e)}), 503
    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}", exc_info=True)
        return jsonify({"error": "Internal server error"}), 500

@app.route('/api/process/<process_id>/timing')
def get_process_timing(process_id):
    """Get detailed timing information for a specific process."""
    try:
        logger.debug(f"Fetching timing data for process {process_id}")
        response = requests.get(f'{API_BASE}/process/{process_id}/timing', headers=API_HEADERS, timeout=5)
        response.raise_for_status()
        return jsonify(response.json())
    except requests.exceptions.ConnectionError as e:
        logger.error(f"Connection error while fetching process timing: {e}")
        return jsonify({"error": "Failed to connect to API server"}), 503
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 404:
            return jsonify({"error": "Process not found"}), 404
        logger.error(f"HTTP error while fetching process timing: {e}")
        return jsonify({"error": "Failed to fetch process timing"}), e.response.status_code
    except Exception as e:
        logger.error(f"Error fetching process timing: {e}")
        return jsonify({"error": "Failed to fetch process timing"}), 500

@app.route('/api/process/<process_id>', methods=['GET'])
def get_process_info(process_id):
    """Get detailed information about a specific process."""
    try:
        logger.debug(f"Fetching process info for {process_id}")
        response = requests.get(f'{API_BASE}/process/{process_id}', headers=API_HEADERS, timeout=5)
        response.raise_for_status()
        return jsonify(response.json())
    except requests.exceptions.ConnectionError as e:
        logger.error(f"Connection error while fetching process info: {e}")
        return jsonify({"error": "Failed to connect to API server"}), 503
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 404:
            return jsonify({"error": "Process not found"}), 404
        logger.error(f"HTTP error while fetching process info: {e}")
        return jsonify({"error": "Failed to fetch process info"}), e.response.status_code
    except Exception as e:
        logger.error(f"Error fetching process info: {e}")
        return jsonify({"error": "Failed to fetch process info"}), 500

@app.route('/api/process/<process_id>', methods=['DELETE'])
def terminate_process(process_id):
    """Terminate a running process."""
    try:
        response = requests.delete(f'{API_BASE}/process/{process_id}', headers=API_HEADERS, timeout=5)
        response.raise_for_status()
        return jsonify({"message": "Process terminated successfully"})
    except requests.exceptions.ConnectionError as e:
        logger.error(f"Connection error while terminating process: {e}")
        return jsonify({"error": "Failed to connect to API server"}), 503
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 404:
            return jsonify({"error": "Process not found"}), 404
        logger.error(f"HTTP error while terminating process: {e}")
        return jsonify({"error": "Failed to terminate process"}), e.response.status_code
    except Exception as e:
        logger.error(f"Error terminating process: {e}")
        return jsonify({"error": "Failed to terminate process"}), 500

@app.route('/api/history')
def get_history():
    """Fetch and return execution history with pagination support."""
    try:
        # Get pagination parameters from query string
        page = request.args.get('page', 1, type=int)
        limit = request.args.get('limit', 10, type=int)
        sort_by = request.args.get('sort_by', 'timestamp')
        order = request.args.get('order', 'desc')

        # Validate and sanitize parameters
        limit = min(max(1, limit), 50)  # Ensure limit is between 1 and 50
        page = max(1, page)  # Ensure page is at least 1

        logger.debug(f"Fetching history with params: page={page}, limit={limit}, sort_by={sort_by}, order={order}")

        # Make the API request
        response = requests.get(
            f'{API_BASE}/history',
            headers=API_HEADERS,
            timeout=5
        )
        response.raise_for_status()

        # Get all items and sort them
        items = response.json() if isinstance(response.json(), list) else []

        # Sort items based on sort_by and order
        reverse = order.lower() == 'desc'
        items.sort(
            key=lambda x: str(x.get(sort_by, '')),
            reverse=reverse
        )

        # Simple pagination calculation
        total_items = len(items)
        start_idx = (page - 1) * limit
        end_idx = start_idx + limit
        paginated_items = items[start_idx:end_idx]
        total_pages = (total_items + limit - 1) // limit

        return jsonify({
            'items': paginated_items,
            'total': total_items,
            'page': page,
            'pages': total_pages,
            'sort': {
                'field': sort_by,
                'order': order
            }
        })

    except requests.exceptions.RequestException as e:
        logger.error(f"API request error: {str(e)}", exc_info=True)
        return jsonify({
            'items': [],
            'total': 0,
            'page': 1,
            'pages': 1,
            'error': 'Failed to fetch history data'
        }), 503


@app.route('/api/history/<execution_id>')
def get_execution_details(execution_id):
    """Get detailed information about a specific execution."""
    try:
        response = requests.get(f'{API_BASE}/history/{execution_id}', headers=API_HEADERS, timeout=5)
        response.raise_for_status()
        return jsonify(response.json())
    except requests.exceptions.ConnectionError as e:
        logger.error(f"Connection error while fetching execution details: {e}")
        return jsonify({"error": "Failed to connect to API server"}), 503
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 404:
            return jsonify({"error": "Execution not found"}), 404
        logger.error(f"HTTP error while fetching execution details: {e}")
        return jsonify({"error": "Failed to fetch execution details"}), e.response.status_code
    except Exception as e:
        logger.error(f"Error fetching execution details: {e}")
        return jsonify({"error": "Failed to fetch execution details"}), 500

@app.template_filter('format_timestamp')
def format_timestamp(timestamp):
    """Format ISO timestamp to readable format."""
    if not timestamp:
        return ''
    try:
        dt = datetime.fromisoformat(timestamp.replace('Z', '+00:00'))
        return dt.strftime('%Y-%m-%d %H:%M:%S')
    except Exception as e:
        logger.error(f"Error formatting timestamp: {e}")
        return timestamp

@app.template_filter('format_bytes')
def format_bytes(bytes):
    """Format bytes to human readable format."""
    if not bytes:
        return '0 B'
    units = ['B', 'KB', 'MB', 'GB']
    i = 0
    value = float(bytes)
    while value >= 1024 and i < len(units)-1:
        value /= 1024
        i += 1
    return f"{value:.2f} {units[i]}"

def list_images():
    try:
        response = requests.get(f"{API_BASE}/images", headers=API_HEADERS, timeout=30)
        response.raise_for_status()
        return response.json()['images']
    except Exception as e:
        flash(f"Failed to list images: {str(e)}", "error")
        return []

def create_image(language, version, files=None):
    try:
        data = {
            "language": language,
            "version": version,
            "files": files or []
        }
        response = requests.post(f"{API_BASE}/images", headers=API_HEADERS, json=data, timeout=60)
        response.raise_for_status()
        flash(f"Successfully created image {language}-{version}", "success")
        return response.json()
    except Exception as e:
        flash(f"Failed to create image: {str(e)}", "error")
        return None

def delete_image(image_id):
    try:
        response = requests.delete(f"{API_BASE}/images/{image_id}", headers=API_HEADERS, timeout=30)
        response.raise_for_status()
        flash(f"Successfully deleted image {image_id}", "success")
        return True
    except Exception as e:
        flash(f"Failed to delete image: {str(e)}", "error")
        return False

@app.route("/images")
def images_page():
    images = list_images()
    return render_template("images.html", images=images)

@app.route("/images/create", methods=["GET", "POST"])
def create_image_page():
    if request.method == "POST":
        language = request.form.get("language")
        version = request.form.get("version")
        if language and version:
            create_image(language, version)
            return redirect(url_for("images_page"))
    return render_template("create_image.html")

@app.route("/images/delete/<image_id>", methods=["POST"])
def delete_image_route(image_id):
    delete_image(image_id)
    return redirect(url_for("images_page"))

@app.route('/api/processes')
def get_processes():
    """Get list of active processes."""
    try:
        response = requests.get(f'{API_BASE}/processes', headers=API_HEADERS, timeout=30)
        response.raise_for_status()
        return jsonify(response.json())
    except requests.exceptions.RequestException as e:
        logger.error(f"API request error: {str(e)}", exc_info=True)
        return jsonify({"error": str(e)}), 503
    except Exception as e:
        logger.error(f"Error fetching processes: {e}", exc_info=True)
        return jsonify({"error": "Failed to fetch processes"}), 500

@app.route('/processes')
def processes():
    """Render the processes page."""
    try:
        logger.debug("Rendering processes page")
        return render_template('processes.html')
    except Exception as e:
        logger.error(f"Error rendering processes page: {e}", exc_info=True)
        return "Internal Server Error", 500

if __name__ == '__main__':
    app.run(host="0.0.0.0", port=5000, debug=True)
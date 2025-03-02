// Function to load and display VM images
async function loadImages() {
    try {
        const response = await fetch('/api/images');
        const data = await response.json();
        
        const imagesTable = document.getElementById('imagesTable');
        if (!data.images || data.images.length === 0) {
            imagesTable.innerHTML = `
                <tr>
                    <td colspan="5" class="text-center">No VM images found</td>
                </tr>
            `;
            return;
        }

        imagesTable.innerHTML = data.images.map(image => `
            <tr>
                <td>${image.imageId}</td>
                <td>${image.imageId.split('-')[0]}</td>
                <td>${image.imageId.split('-')[1] || 'N/A'}</td>
                <td>
                    <span class="badge bg-success">Available</span>
                </td>
                <td>
                    <button class="btn btn-sm btn-danger" onclick="deleteImage('${image.imageId}')" title="Delete Image">
                        <i class="fas fa-trash"></i>
                    </button>
                </td>
            </tr>
        `).join('');
    } catch (error) {
        console.error('Error loading images:', error);
        document.getElementById('imagesTable').innerHTML = `
            <tr>
                <td colspan="5" class="text-center text-danger">Error loading images</td>
            </tr>
        `;
    }
}

// Function to create a new VM image
async function createImage() {
    const language = document.getElementById('language').value;
    const version = document.getElementById('version').value;
    const requirements = document.getElementById('requirements').value;

    if (!language || !version) {
        alert('Please fill in all required fields');
        return;
    }

    const files = [
        {
            name: 'requirements.txt',
            content: requirements || '# Base requirements'
        }
    ];

    try {
        const response = await fetch('/api/images', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                language,
                version,
                files
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();
        
        // Close the modal and reload images
        const modal = bootstrap.Modal.getInstance(document.getElementById('createImageModal'));
        modal.hide();
        
        // Clear the form
        document.getElementById('createImageForm').reset();
        
        // Reload images list
        loadImages();
        
        // Show success message
        alert('Image created successfully!');
    } catch (error) {
        console.error('Error creating image:', error);
        alert('Failed to create image. Please try again.');
    }
}

// Function to delete a VM image
async function deleteImage(imageId) {
    if (!confirm(`Are you sure you want to delete image "${imageId}"?`)) {
        return;
    }

    try {
        const response = await fetch(`/api/images/${imageId}`, {
            method: 'DELETE'
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Reload images list
        loadImages();
    } catch (error) {
        console.error('Error deleting image:', error);
        alert('Failed to delete image. Please try again.');
    }
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    // Load images when page loads
    loadImages();

    // Add event listener for create image button
    document.getElementById('createImageBtn').addEventListener('click', createImage);
});

// Refresh images list every 30 seconds
setInterval(loadImages, 30000); 
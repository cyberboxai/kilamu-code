from app.repositories.customer_repository import CustomerRepository


class CustomerNotFound(Exception):
    pass


class CustomerService:
    def __init__(self, repository: CustomerRepository):
        self.repository = repository

    def get_customer(self, customer_id: int):
        customer = self.repository.get(customer_id)
        if customer is None:
            raise CustomerNotFound(customer_id)
        return customer
